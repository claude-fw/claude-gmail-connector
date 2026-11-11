// Autenticazione: passphrase (secondo fattore) + identita' Google (Gate 3) + consenso Gmail.
// Scope Gmail: gmail.readonly + gmail.modify (organizzazione, bozze e invio di bozze solo con conferma fuori banda;
// nessun gmail.send/gmail.compose richiesto). I token Google finiscono solo nei props del grant (cifrati). Nessun log.
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { GMAIL_MODIFY, GMAIL_READONLY, GOOGLE_TOKEN_URL, tokensFromCodeExchange } from "./google.ts";
import { FAIL_DELAY_MS, SECURITY_HEADERS, enc, esc, getCookie, html, plain, randomToken, safeEqual } from "./web.ts";

const CSRF_COOKIE = "csrf_gate1";

// Gate 3-4
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_SCOPES = `openid email ${GMAIL_READONLY} ${GMAIL_MODIFY}`;
const G3_COOKIE = "g3_state";
const G3_KV_PREFIX = "gate3:state:"; // prefisso separato da quelli del provider (client:, grant:, token:)
const G3_TTL_S = 600;
const GOOGLE_TOKEN_ERRORS = ["invalid_client", "invalid_grant", "redirect_uri_mismatch", "unauthorized_client", "invalid_request"];

function b64urlEncode(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function csrfCookie(value: string, secure: boolean, maxAge: number): string {
  return `${CSRF_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/authorize; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function page(opts: { clientName: string; redirectHost: string; state: string; csrf: string; error?: string }): string {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizza accesso</title>
<style>
body{font:16px -apple-system,system-ui,sans-serif;max-width:28rem;margin:10vh auto;padding:0 1rem;color:#1d1d1f}
@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}}
input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem}
button{cursor:pointer}.err{color:#d70015}small{opacity:.7}
</style></head><body>
<h1>private-google-mcp</h1>
<p>Il client <strong>${esc(opts.clientName)}</strong> (ritorno a <code>${esc(opts.redirectHost)}</code>) chiede di collegarsi a questo server.</p>
<p><small>Dopo la passphrase si accede con l'account Google privato e si concedono lettura e gestione di Gmail (gmail.readonly, gmail.modify). Ogni invio richiede una conferma separata.</small></p>
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="state" value="${esc(opts.state)}">
<label>Passphrase<input type="password" name="passphrase" autocomplete="off" autofocus required></label>
<button type="submit">Autorizza</button>
</form></body></html>`;
}

function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_ALLOWED_EMAIL);
}

function g3Cookie(value: string, secure: boolean, maxAge: number): string {
  // Lax (non Strict): il ritorno da Google e' una navigazione cross-site, con Strict il cookie non arriverebbe.
  return `${G3_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/callback; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// L'id_token arriva direttamente dal token endpoint di Google via HTTPS: secondo Google la firma
// non va verificata in questo caso, ma i claim si' (iss, aud, exp, email_verified, email).
function idTokenClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Restituisce solo QUALE controllo fallisce (parola fissa), mai i valori; null se tutto ok.
// Esportata per i test (tests/claims.test.mts).
export async function checkGoogleClaims(
  claims: Record<string, unknown> | null,
  clientId: string,
  allowedEmail: string,
  now: number,
): Promise<string | null> {
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : "";
  if (!claims || typeof claims.sub !== "string" || typeof claims.exp !== "number" || email === "") return "dati_mancanti";
  if (!GOOGLE_ISSUERS.includes(String(claims.iss))) return "iss";
  if (claims.aud !== clientId) return "aud";
  if (claims.exp <= now) return "scaduto";
  if (claims.email_verified !== true) return "email_non_verificata";
  if (!(await safeEqual(email, allowedEmail.trim().toLowerCase()))) return "email_diversa";
  return null;
}

const LOOPBACK_HOSTS = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * La redirect richiesta e' una di quelle registrate? Corrispondenza esatta, oppure (RFC 8252 par. 7.3, come fa il
 * provider OAuth) per redirect su loopback http stessa forma tranne la porta: Claude Code usa una porta diversa
 * a ogni sessione. Host, schema, percorso e query devono coincidere; nessun'altra eccezione.
 */
export function redirectAllowed(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !LOOPBACK_HOSTS.test(req.hostname) || req.username || req.password || req.hash) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return reg.protocol === req.protocol && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
    } catch {
      return false;
    }
  });
}

async function resolveClient(env: Env, oauthReq: AuthRequest) {
  if (typeof oauthReq?.clientId !== "string" || typeof oauthReq?.redirectUri !== "string") return null;
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return null;
  // La redirect URI deve essere una di quelle registrate dal client (anche dopo il giro nel form).
  if (!redirectAllowed(client.redirectUris, oauthReq.redirectUri)) return null;
  return client;
}

export const authHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secure = url.protocol === "https:";

    if (url.pathname === "/callback") {
      if (request.method !== "GET") return plain("Method not allowed", 405);
      return googleCallback(request, env, url, secure);
    }
    if (url.pathname !== "/authorize") return plain("Not found", 404);

    if (request.method === "GET") {
      let oauthReq: AuthRequest;
      try {
        oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch {
        return plain("Richiesta di autorizzazione non valida.", 400);
      }
      const client = await resolveClient(env, oauthReq);
      if (!client) return plain("Client o redirect URI non valido.", 400);

      const csrf = randomToken();
      const body = page({
        clientName: client.clientName ?? client.clientId,
        redirectHost: new URL(oauthReq.redirectUri).host,
        state: b64urlEncode(JSON.stringify(oauthReq)),
        csrf,
      });
      return html(body, 200, { "Set-Cookie": csrfCookie(csrf, secure, 600) });
    }

    if (request.method === "POST") {
      // Difesa CSRF: Origin same-origin + token nel form uguale al cookie HttpOnly.
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return plain("Origine non consentita.", 403);

      const form = await request.formData();
      const csrfField = String(form.get("csrf") ?? "");
      const csrfCk = getCookie(request, CSRF_COOKIE);
      if (!csrfCk || !(await safeEqual(csrfField, csrfCk))) return plain("Sessione scaduta o non valida.", 403);

      let oauthReq: AuthRequest;
      try {
        oauthReq = JSON.parse(b64urlDecode(String(form.get("state") ?? ""))) as AuthRequest;
      } catch {
        return plain("Richiesta non valida.", 400);
      }
      const client = await resolveClient(env, oauthReq);
      if (!client) return plain("Client o redirect URI non valido.", 400);

      // Fail closed: se i segreti non sono configurati, nessuno entra.
      if (!env.GATE1_PASSPHRASE || !googleConfigured(env)) return plain("Server non configurato.", 500);

      const supplied = String(form.get("passphrase") ?? "");
      if (!(await safeEqual(supplied, env.GATE1_PASSPHRASE))) {
        await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
        return html(
          page({
            clientName: client.clientName ?? client.clientId,
            redirectHost: new URL(oauthReq.redirectUri).host,
            state: b64urlEncode(JSON.stringify(oauthReq)),
            csrf: csrfCk,
            error: "Passphrase errata.",
          }),
          403,
        );
      }

      // Passphrase corretta: secondo passo = identita' Google. La richiesta OAuth di Claude resta
      // nel KV (monouso, 10 minuti) legata a uno state casuale, anche nel cookie del browser.
      const g3State = randomToken();
      const verifier = randomToken();
      await env.OAUTH_KV.put(G3_KV_PREFIX + g3State, JSON.stringify({ oauthReq, verifier }), {
        expirationTtl: G3_TTL_S,
      });
      const google = new URL(GOOGLE_AUTH_URL);
      google.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${url.origin}/callback`,
        response_type: "code",
        scope: GOOGLE_SCOPES,
        state: g3State,
        code_challenge: await pkceChallenge(verifier),
        code_challenge_method: "S256",
        login_hint: env.GOOGLE_ALLOWED_EMAIL,
        // offline + consent: Google rilascia il refresh token (necessario per gmail.readonly senza login continui).
        access_type: "offline",
        prompt: "consent select_account",
        include_granted_scopes: "true",
      }).toString();

      const headers = new Headers({ Location: google.toString(), ...SECURITY_HEADERS });
      headers.append("Set-Cookie", csrfCookie("", secure, 0));
      headers.append("Set-Cookie", g3Cookie(g3State, secure, G3_TTL_S));
      return new Response(null, { status: 302, headers });
    }

    return plain("Method not allowed", 405);
  },
};

async function googleCallback(request: Request, env: Env, url: URL, secure: boolean): Promise<Response> {
  if (!googleConfigured(env)) return plain("Server non configurato.", 500);

  // Lo state deve combaciare con il cookie di QUESTO browser (anti-CSRF / login injection).
  const state = url.searchParams.get("state") ?? "";
  const stateCk = getCookie(request, G3_COOKIE);
  if (!state || !stateCk || !(await safeEqual(state, stateCk))) return plain("Sessione non valida.", 403);

  // Monouso: si legge e si cancella subito.
  const key = G3_KV_PREFIX + state;
  const saved = await env.OAUTH_KV.get<{ oauthReq: AuthRequest; verifier: string }>(key, { type: "json" });
  await env.OAUTH_KV.delete(key);
  const clear = { "Set-Cookie": g3Cookie("", secure, 0) };
  if (!saved) return html("Sessione scaduta: ricomincia il collegamento da Claude.", 400, clear);

  if (url.searchParams.get("error")) return html("Accesso Google annullato o negato.", 403, clear);
  const code = url.searchParams.get("code");
  if (!code) return html("Risposta Google non valida.", 400, clear);

  let tokenRes: Response;
  try {
    tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/callback`,
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return html("Scambio del codice Google non riuscito (rete).", 502, clear);
  }
  if (!tokenRes.ok) {
    // Diagnostica: solo il campo `error` di Google, e solo se e' un codice noto. Mai error_description,
    // code, token o secret; nessun log.
    let reason = "altro";
    try {
      const err = ((await tokenRes.json()) as { error?: unknown }).error;
      if (typeof err === "string" && GOOGLE_TOKEN_ERRORS.includes(err)) reason = err;
    } catch {
      /* corpo non JSON: resta "altro" */
    }
    return html(`Scambio del codice Google non riuscito (${reason}).`, 502, clear);
  }
  let tok: { id_token?: string; access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown };
  try {
    tok = (await tokenRes.json()) as typeof tok;
  } catch {
    return html("Scambio del codice Google non riuscito (risposta non valida).", 502, clear);
  }
  const claims = tok.id_token ? idTokenClaims(tok.id_token) : null;

  const now = Math.floor(Date.now() / 1000);
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : "";
  const failed = await checkGoogleClaims(claims, env.GOOGLE_CLIENT_ID, env.GOOGLE_ALLOWED_EMAIL, now);
  if (failed) {
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return html(`Account Google non autorizzato per questo server (${failed}).`, 403, clear);
  }

  // Gate 4: la lettura di Gmail (readonly o modify) deve essere stata concessa davvero (consenso granulare) e serve
  // il refresh token. Se manca solo gmail.modify il collegamento resta in sola lettura (scrittura: scope_insufficiente).
  const granted = tokensFromCodeExchange(tok, now);
  if (!granted.tokens) {
    return html(`Permesso Gmail non concesso: ricollega e consenti la lettura di Gmail (${granted.error}).`, 403, clear);
  }

  const client = await resolveClient(env, saved.oauthReq);
  if (!client) return html("Client o redirect URI non valido.", 400, clear);

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: saved.oauthReq,
    userId: "owner",
    metadata: { clientName: client.clientName ?? client.clientId, gate: 4 },
    scope: saved.oauthReq.scope,
    props: { userId: "owner", gate: 4, googleSub: claims!.sub as string, googleEmail: email, google: granted.tokens },
  });

  return new Response(null, { status: 302, headers: { Location: redirectTo, ...clear, ...SECURITY_HEADERS } });
}
