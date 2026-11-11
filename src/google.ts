// Google tokens (gmail.readonly / gmail.modify), refresh and minimal Gmail API calls (called "Gate 4" in the code history).
// Regole: i token non compaiono mai in errori, risultati o log; gli errori sono parole fisse.
// `fetchImpl` e' iniettabile per i test (tests/google.test.mts).

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
/** Lettura, organizzazione, bozze e invio di bozze (drafts.send, solo dopo conferma fuori banda). Nessuna cancellazione definitiva. */
export const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const HTTP_TIMEOUT_MS = 10_000;
const EXPIRY_MARGIN_S = 60; // un token che scade entro un minuto si considera gia' scaduto

type FetchFn = typeof fetch;

/** Token Google salvati nei props del grant (cifrati dal provider OAuth). */
export interface GoogleTokens {
  accessToken: string;
  /** Scadenza dell'access token, in secondi Unix. */
  expiresAt: number;
  refreshToken: string;
  /** Scope effettivamente concessi da Google (separati da spazio). */
  scope: string;
}

/** Errore senza dati sensibili: `code` e' una parola fissa. */
export class GoogleError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "GoogleError";
    this.code = code;
  }
}

export function hasScope(granted: string, wanted: string): boolean {
  return granted.split(/\s+/).includes(wanted);
}

/** Accesso in lettura a Gmail: gmail.readonly oppure gmail.modify (che lo include, consenso granulare di Google). */
export function hasGmailRead(granted: string): boolean {
  return hasScope(granted, GMAIL_READONLY) || hasScope(granted, GMAIL_MODIFY);
}

/** Dalla risposta del token endpoint (scambio del code) ai token da salvare; null + motivo se manca qualcosa. */
export function tokensFromCodeExchange(
  body: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown },
  now: number,
): { tokens: GoogleTokens; error: null } | { tokens: null; error: string } {
  const scope = typeof body.scope === "string" ? body.scope : "";
  if (!hasGmailRead(scope)) return { tokens: null, error: "scope_mancante" };
  if (typeof body.refresh_token !== "string" || !body.refresh_token) return { tokens: null, error: "refresh_mancante" };
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    return { tokens: null, error: "dati_mancanti" };
  }
  return {
    tokens: {
      accessToken: body.access_token,
      expiresAt: now + body.expires_in,
      refreshToken: body.refresh_token,
      scope,
    },
    error: null,
  };
}

export function isExpired(tokens: GoogleTokens, now: number): boolean {
  return tokens.expiresAt - EXPIRY_MARGIN_S <= now;
}

/**
 * Rinnova l'access token Google con il refresh token.
 * GoogleError("invalid_grant"): refresh token revocato o scaduto (es. 7 giorni in modalita' Testing),
 * serve ricollegare il connettore. GoogleError("refresh_non_riuscito"): errore temporaneo o di configurazione.
 */
export async function refreshGoogleTokens(
  tokens: GoogleTokens,
  clientId: string,
  clientSecret: string,
  now: number,
  fetchImpl: FetchFn = fetch,
): Promise<GoogleTokens> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleError("refresh_non_riuscito");
  }
  let body: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown; error?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* corpo non JSON */
  }
  if (!res.ok) throw new GoogleError(body.error === "invalid_grant" ? "invalid_grant" : "refresh_non_riuscito");
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new GoogleError("refresh_non_riuscito");
  }
  const scope = typeof body.scope === "string" ? body.scope : tokens.scope;
  if (!hasGmailRead(scope)) throw new GoogleError("scope_mancante");
  return {
    accessToken: body.access_token,
    expiresAt: now + body.expires_in,
    // Google di solito non ruota il refresh token; se ne manda uno nuovo, si usa quello.
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : tokens.refreshToken,
    scope,
  };
}

/** Restituisce token validi, rinnovandoli solo se scaduti (in memoria: il salvataggio lo fa tokenExchangeCallback). */
export async function freshTokens(
  tokens: GoogleTokens,
  clientId: string,
  clientSecret: string,
  now: number,
  fetchImpl: FetchFn = fetch,
): Promise<GoogleTokens> {
  return isExpired(tokens, now) ? refreshGoogleTokens(tokens, clientId, clientSecret, now, fetchImpl) : tokens;
}

/**
 * Chiamata alla Gmail API (`users/me`). `path` inizia con "/"; `query` diventa la query string
 * (gli array diventano parametri ripetuti). Errori (parole fisse): gmail_non_autorizzato (401),
 * gmail_permesso_negato (403), gmail_non_trovato (404), gmail_richiesta_non_valida (400),
 * gmail_limite (429), gmail_errore (altro, rete, timeout, risposta non JSON). Corpo vuoto (es. 204) -> undefined.
 */
export async function gmailRequest<T>(
  accessToken: string,
  // Nessun DELETE: la cancellazione (definitiva) non e' una capacita' prevista di questo server.
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: { query?: Record<string, string | number | boolean | string[] | undefined>; body?: unknown } = {},
  fetchImpl: FetchFn = fetch,
): Promise<T> {
  const url = new URL(`${GMAIL_API}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleError("gmail_errore");
  }
  if (res.status === 400) throw new GoogleError("gmail_richiesta_non_valida");
  if (res.status === 401) throw new GoogleError("gmail_non_autorizzato");
  if (res.status === 403) throw new GoogleError("gmail_permesso_negato");
  if (res.status === 404) throw new GoogleError("gmail_non_trovato");
  if (res.status === 429) throw new GoogleError("gmail_limite");
  if (!res.ok) throw new GoogleError("gmail_errore");
  // Alcune operazioni (es. batchModify) rispondono 204 o con corpo vuoto.
  const text = await res.text().catch(() => "");
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GoogleError("gmail_errore");
  }
}

/** GET sulla Gmail API (sola lettura). */
export function gmailGet<T>(accessToken: string, path: string, fetchImpl: FetchFn = fetch): Promise<T> {
  return gmailRequest<T>(accessToken, "GET", path, {}, fetchImpl);
}

/** Verifica minima di Gate 4: il profilo Gmail (indirizzo e conteggi), senza leggere messaggi. */
export async function gmailProfile(
  accessToken: string,
  fetchImpl: FetchFn = fetch,
): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number }> {
  const p = await gmailGet<{ emailAddress?: unknown; messagesTotal?: unknown; threadsTotal?: unknown }>(
    accessToken,
    "/profile",
    fetchImpl,
  );
  return {
    emailAddress: typeof p.emailAddress === "string" ? p.emailAddress : "",
    messagesTotal: typeof p.messagesTotal === "number" ? p.messagesTotal : 0,
    threadsTotal: typeof p.threadsTotal === "number" ? p.threadsTotal : 0,
  };
}

/** Durata del token di Claude allineata a quella del token Google (tra 60 s e 1 h). */
export function accessTokenTtl(tokens: GoogleTokens, now: number): number {
  return Math.max(60, Math.min(3600, tokens.expiresAt - now - EXPIRY_MARGIN_S));
}

/**
 * Logica di tokenExchangeCallback (src/index.ts), separata per i test.
 * - authorization_code: solo la durata del token di Claude, allineata a Google.
 * - refresh_token: rinnova il token Google e lo salva nei props del grant.
 *   invalid_grant / scope_mancante -> GoogleError rilanciato (index.ts revoca il grant: serve ricollegarsi).
 *   Errore temporaneo -> nessuna modifica: il tool rinnovera' in memoria alla prossima chiamata.
 * Grant senza token Google (Gate 3): nessuna modifica.
 */
export async function onTokenExchange(
  grantType: string,
  props: { google?: GoogleTokens } & Record<string, unknown>,
  clientId: string,
  clientSecret: string,
  now: number,
  fetchImpl: FetchFn = fetch,
): Promise<{ newProps?: Record<string, unknown>; accessTokenTTL?: number } | undefined> {
  const google = props?.google;
  if (!google) return undefined;
  if (grantType === "authorization_code") return { accessTokenTTL: accessTokenTtl(google, now) };
  if (grantType !== "refresh_token") return undefined;
  try {
    const refreshed = await refreshGoogleTokens(google, clientId, clientSecret, now, fetchImpl);
    return { newProps: { ...props, google: refreshed }, accessTokenTTL: accessTokenTtl(refreshed, now) };
  } catch (e) {
    if (e instanceof GoogleError && (e.code === "invalid_grant" || e.code === "scope_mancante")) throw e;
    return undefined;
  }
}
