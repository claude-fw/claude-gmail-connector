// Test end-to-end LOCALE del Gate 1 contro `wrangler dev` (default http://localhost:8787).
// Esegue: discovery -> registrazione client (DCR) -> /authorize con passphrase -> redirect a Google (Gate 4)
// -> controlli negativi su /callback. Il login Google reale (e quindi /token e MCP con token) si prova solo su claude.ai.
// Required start: `npx wrangler dev --var GOOGLE_CLIENT_SECRET:dummy --var GOOGLE_ALLOWED_EMAIL:test@example.com` (see README, Development).
// Non stampa mai token ne' passphrase. Legge la passphrase da .dev.vars.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
  return ok;
};

const info = (name, ok, extra = "") =>
  console.log(`${ok ? "PASS" : "WARN"}  ${name}${extra ? "  -> " + extra : ""}`);

function readPassphrase() {
  const t = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
  const m = t.match(/^GATE1_PASSPHRASE=(.*)$/m);
  if (!m) throw new Error("GATE1_PASSPHRASE non trovata in .dev.vars");
  return m[1].trim().replace(/^["']|["']$/g, "");
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");

async function rpc(body, token, extraHeaders = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (text) {
    if ((res.headers.get("content-type") ?? "").includes("event-stream")) {
      const datas = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      if (datas.length) json = JSON.parse(datas[datas.length - 1]);
    } else {
      try { json = JSON.parse(text); } catch { /* non JSON */ }
    }
  }
  return { res, json };
}

try {
  const pass = readPassphrase();

  // 1. /mcp senza token deve essere rifiutato
  const anon = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
  check("/mcp senza token -> 401", anon.res.status === 401, `status ${anon.res.status}`);
  const prmUrl = (anon.res.headers.get("www-authenticate") ?? "").match(/resource_metadata="([^"]+)"/)?.[1];
  check("401 con WWW-Authenticate (resource_metadata)", !!prmUrl, prmUrl ?? "");

  // 2. discovery OAuth
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("metadata authorization-server", !!(meta.authorization_endpoint && meta.token_endpoint && meta.registration_endpoint));
  check("PKCE S256 dichiarato", (meta.code_challenge_methods_supported ?? []).includes("S256"));
  // RFC 9728: il provider 1.x pubblica i metadata con il suffisso del path (/.well-known/oauth-protected-resource/mcp).
  const prm = await fetch(prmUrl ?? `${BASE}/.well-known/oauth-protected-resource/mcp`);
  check("metadata protected-resource (serve a Claude)", prm.status === 200, `status ${prm.status}`);
  const prmJson = await prm.json().catch(() => ({}));
  check("resource = URL del Worker + /mcp", prmJson.resource === `${BASE}/mcp`, `resource=${prmJson.resource}`);

  // 3. registrazione dinamica del client (DCR)
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "smoke-test-gate1",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const client = await reg.json();
  check("registrazione client (DCR)", reg.status < 300 && !!client.client_id, `status ${reg.status}`);

  // 4. /authorize (PKCE)
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const state = b64u(randomBytes(8));
  const authUrl = `${BASE}/authorize?` + new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state,
  });
  const page = await fetch(authUrl);
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const stateField = html.match(/name="state" value="([^"]+)"/)?.[1];
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("csrf_gate1="));
  check("pagina di consenso", page.status === 200 && !!csrf && !!stateField && !!cookie, `status ${page.status}`);

  const post = (passphrase, ck = cookie) =>
    fetch(`${BASE}/authorize`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: ck, Origin: BASE },
      body: new URLSearchParams({ csrf, state: stateField, passphrase }),
    });

  // 5. passphrase errata -> nessun redirect/codice
  const bad = await post("passphrase-sbagliata");
  check("passphrase errata rifiutata", bad.status === 403 && !bad.headers.get("location"), `status ${bad.status}`);

  // 6. CSRF: senza cookie corretto -> rifiutato
  const noCsrf = await post(pass, "csrf_gate1=altro");
  check("CSRF non valido rifiutato", noCsrf.status === 403, `status ${noCsrf.status}`);

  // 7. passphrase corretta -> redirect a Google: "openid email" + gmail.readonly + gmail.modify (MAI send/compose), offline, state, PKCE
  const ok = await post(pass);
  const loc = ok.headers.get("location") ?? "";
  const g = loc ? new URL(loc) : null;
  const gp = g?.searchParams;
  check("passphrase corretta -> redirect a Google", ok.status === 302 && g?.origin === "https://accounts.google.com", `status ${ok.status}`);
  check("scope Google = 'openid email' + gmail.readonly + gmail.modify (nessun send/compose)",
    gp?.get("scope") === "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify" &&
      !/gmail\.(send|compose)|mail\.google\.com/.test(gp?.get("scope") ?? ""), `scope=${gp?.get("scope")}`);
  check("redirect_uri Google = BASE/callback", gp?.get("redirect_uri") === `${BASE}/callback`);
  check("PKCE S256 verso Google", gp?.get("code_challenge_method") === "S256" && !!gp?.get("code_challenge"));
  check("access_type=offline + prompt con consent (refresh token Google)",
    gp?.get("access_type") === "offline" && (gp?.get("prompt") ?? "").split(" ").includes("consent"));
  check("include_granted_scopes=true", gp?.get("include_granted_scopes") === "true");
  const gState = gp?.get("state") ?? "";
  const g3 = (ok.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("g3_state="));
  check("cookie g3_state legato allo state", !!gState && g3 === `g3_state=${gState}`);

  // 8. /callback: controlli negativi (nessun Google reale)
  const cb = (qs, ck) => fetch(`${BASE}/callback?${new URLSearchParams(qs)}`, { redirect: "manual", headers: ck ? { Cookie: ck } : {} });
  const noCk = await cb({ state: gState, code: "x" });
  check("/callback senza cookie -> 403", noCk.status === 403, `status ${noCk.status}`);
  const wrongCk = await cb({ state: gState, code: "x" }, "g3_state=altro");
  check("/callback con state diverso dal cookie -> 403", wrongCk.status === 403, `status ${wrongCk.status}`);
  const denied = await cb({ state: gState, error: "access_denied" }, g3);
  check("/callback con error=access_denied -> 403, nessun redirect", denied.status === 403 && !denied.headers.get("location"), `status ${denied.status}`);
  const reuse = await cb({ state: gState, code: "x" }, g3);
  check("state monouso: riuso -> 400", reuse.status === 400, `status ${reuse.status}`);

  // 9. il redirect verso Claude NON avviene senza Google
  check("nessun code verso Claude senza login Google", !loc.startsWith(REDIRECT));

  // 9b. pagina di conferma delle azioni: instradata, azione inesistente -> 404, intestazioni di sicurezza
  const conf = await fetch(`${BASE}/confirm/${"0".repeat(64)}`);
  check("/confirm/<id inesistente> -> 404 con CSP", conf.status === 404 && /default-src 'none'/.test(conf.headers.get("content-security-policy") ?? ""), `status ${conf.status}`);
  const confBad = await fetch(`${BASE}/confirm/..%2Fadmin`);
  check("/confirm con id malformato -> 404", confBad.status === 404, `status ${confBad.status}`);

  // 10. token inventato -> 401
  const fake = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "token-inventato");
  check("token non valido -> 401", fake.res.status === 401, `status ${fake.res.status}`);

} catch (e) {
  failures++;
  console.log("ERRORE nello script:", e.message);
}
console.log(failures === 0 ? "\nTUTTO OK" : `\n${failures} controllo/i FALLITO/I`);
process.exit(failures === 0 ? 0 : 1);
