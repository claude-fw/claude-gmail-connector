// Test unitari di src/google.ts con fetch SIMULATO: nessuna chiamata reale a Google, solo dati fittizi.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GMAIL_MODIFY,
  GMAIL_READONLY,
  hasGmailRead,
  GOOGLE_TOKEN_URL,
  GoogleError,
  accessTokenTtl,
  freshTokens,
  gmailGet,
  gmailProfile,
  hasScope,
  isExpired,
  onTokenExchange,
  refreshGoogleTokens,
  tokensFromCodeExchange,
  type GoogleTokens,
} from "../src/google.ts";

const NOW = 1_800_000_000;
const SCOPE = `openid ${GMAIL_READONLY} https://www.googleapis.com/auth/userinfo.email`;
const tokens: GoogleTokens = { accessToken: "AT-FITTIZIO", expiresAt: NOW + 3000, refreshToken: "RT-FITTIZIO", scope: SCOPE };

type Call = { url: string; init?: RequestInit };
function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}
const failingFetch = (async () => {
  throw new TypeError("network down");
}) as unknown as typeof fetch;

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof GoogleError);
    assert.equal(e.code, code);
    // Gli errori non devono mai contenere token.
    assert.ok(!String(e.message).includes("FITTIZIO"));
    return true;
  });
}

test("hasScope: corrispondenza esatta, non per prefisso", () => {
  assert.equal(hasScope(SCOPE, GMAIL_READONLY), true);
  assert.equal(hasScope("openid email", GMAIL_READONLY), false);
  assert.equal(hasScope(`${GMAIL_READONLY}x`, GMAIL_READONLY), false);
});

test("tokensFromCodeExchange: risposta completa -> token da salvare", () => {
  const r = tokensFromCodeExchange({ access_token: "A", expires_in: 3599, refresh_token: "R", scope: SCOPE }, NOW);
  assert.deepEqual(r, { tokens: { accessToken: "A", expiresAt: NOW + 3599, refreshToken: "R", scope: SCOPE }, error: null });
});

test("tokensFromCodeExchange: gmail.readonly non concesso -> scope_mancante", () => {
  const r = tokensFromCodeExchange({ access_token: "A", expires_in: 3599, refresh_token: "R", scope: "openid email" }, NOW);
  assert.equal(r.error, "scope_mancante");
});

test("tokensFromCodeExchange: refresh token assente -> refresh_mancante", () => {
  const r = tokensFromCodeExchange({ access_token: "A", expires_in: 3599, scope: SCOPE }, NOW);
  assert.equal(r.error, "refresh_mancante");
});

test("tokensFromCodeExchange: access token o scadenza assenti -> dati_mancanti", () => {
  assert.equal(tokensFromCodeExchange({ refresh_token: "R", scope: SCOPE }, NOW).error, "dati_mancanti");
  assert.equal(tokensFromCodeExchange({ access_token: "A", expires_in: "3599", refresh_token: "R", scope: SCOPE }, NOW).error, "dati_mancanti");
});

test("isExpired: margine di 60 secondi", () => {
  assert.equal(isExpired({ ...tokens, expiresAt: NOW + 61 }, NOW), false);
  assert.equal(isExpired({ ...tokens, expiresAt: NOW + 60 }, NOW), true);
  assert.equal(isExpired({ ...tokens, expiresAt: NOW - 1 }, NOW), true);
});

test("refreshGoogleTokens: richiesta corretta e nuovo access token, refresh token conservato", async () => {
  const calls: Call[] = [];
  const r = await refreshGoogleTokens(tokens, "CID", "SECRET", NOW, fakeFetch(200, { access_token: "AT2", expires_in: 3599, scope: SCOPE }, calls));
  assert.deepEqual(r, { accessToken: "AT2", expiresAt: NOW + 3599, refreshToken: "RT-FITTIZIO", scope: SCOPE });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GOOGLE_TOKEN_URL);
  assert.equal(calls[0].init?.method, "POST");
  const body = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "RT-FITTIZIO");
  assert.equal(body.get("client_id"), "CID");
  assert.equal(body.get("client_secret"), "SECRET");
});

test("refreshGoogleTokens: se Google ruota il refresh token si usa quello nuovo", async () => {
  const r = await refreshGoogleTokens(tokens, "CID", "S", NOW, fakeFetch(200, { access_token: "AT2", expires_in: 3599, refresh_token: "RT2" }));
  assert.equal(r.refreshToken, "RT2");
  assert.equal(r.scope, SCOPE); // senza scope nella risposta si conserva quello precedente
});

test("refreshGoogleTokens: invalid_grant (revocato o scaduto) -> invalid_grant", async () => {
  await rejectsWith(refreshGoogleTokens(tokens, "CID", "S", NOW, fakeFetch(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })), "invalid_grant");
});

test("refreshGoogleTokens: altri errori -> refresh_non_riuscito", async () => {
  await rejectsWith(refreshGoogleTokens(tokens, "CID", "S", NOW, fakeFetch(401, { error: "invalid_client" })), "refresh_non_riuscito");
  await rejectsWith(refreshGoogleTokens(tokens, "CID", "S", NOW, fakeFetch(500, "errore non JSON")), "refresh_non_riuscito");
  await rejectsWith(refreshGoogleTokens(tokens, "CID", "S", NOW, failingFetch), "refresh_non_riuscito");
  await rejectsWith(refreshGoogleTokens(tokens, "CID", "S", NOW, fakeFetch(200, { expires_in: 3599 })), "refresh_non_riuscito");
});

test("refreshGoogleTokens: scope senza gmail.readonly -> scope_mancante", async () => {
  await rejectsWith(refreshGoogleTokens(tokens, "CID", "S", NOW, fakeFetch(200, { access_token: "AT2", expires_in: 3599, scope: "openid email" })), "scope_mancante");
});

test("freshTokens: token valido -> nessuna chiamata; scaduto -> rinnovo", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(200, { access_token: "AT2", expires_in: 3599, scope: SCOPE }, calls);
  assert.equal(await freshTokens(tokens, "CID", "S", NOW, f), tokens);
  assert.equal(calls.length, 0);
  const r = await freshTokens({ ...tokens, expiresAt: NOW }, "CID", "S", NOW, f);
  assert.equal(r.accessToken, "AT2");
  assert.equal(calls.length, 1);
});

test("gmailGet: header Bearer e mappatura degli errori HTTP", async () => {
  const calls: Call[] = [];
  await gmailGet("AT-FITTIZIO", "/profile", fakeFetch(200, {}, calls));
  assert.equal(calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
  assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), "Bearer AT-FITTIZIO");
  await rejectsWith(gmailGet("AT-FITTIZIO", "/profile", fakeFetch(401, {})), "gmail_non_autorizzato");
  await rejectsWith(gmailGet("AT-FITTIZIO", "/profile", fakeFetch(403, {})), "gmail_permesso_negato");
  await rejectsWith(gmailGet("AT-FITTIZIO", "/profile", fakeFetch(429, {})), "gmail_limite");
  await rejectsWith(gmailGet("AT-FITTIZIO", "/profile", fakeFetch(500, {})), "gmail_errore");
  await rejectsWith(gmailGet("AT-FITTIZIO", "/profile", failingFetch), "gmail_errore");
});

test("gmailProfile: solo indirizzo e conteggi", async () => {
  const p = await gmailProfile("AT", fakeFetch(200, { emailAddress: "nome@example.com", messagesTotal: 12, threadsTotal: 7, historyId: "999" }));
  assert.deepEqual(p, { emailAddress: "nome@example.com", messagesTotal: 12, threadsTotal: 7 });
});

test("accessTokenTtl: tra 60 s e 1 h, con margine", () => {
  assert.equal(accessTokenTtl({ ...tokens, expiresAt: NOW + 3599 }, NOW), 3539);
  assert.equal(accessTokenTtl({ ...tokens, expiresAt: NOW + 7200 }, NOW), 3600);
  assert.equal(accessTokenTtl({ ...tokens, expiresAt: NOW + 30 }, NOW), 60);
});

test("onTokenExchange: grant del Gate 3 (senza token Google) -> nessuna modifica", async () => {
  const calls: Call[] = [];
  assert.equal(await onTokenExchange("refresh_token", { gate: 3 }, "CID", "S", NOW, fakeFetch(200, {}, calls)), undefined);
  assert.equal(calls.length, 0);
});

test("onTokenExchange: authorization_code -> solo durata allineata, nessuna chiamata", async () => {
  const calls: Call[] = [];
  const r = await onTokenExchange("authorization_code", { gate: 4, google: tokens }, "CID", "S", NOW, fakeFetch(200, {}, calls));
  assert.deepEqual(r, { accessTokenTTL: 2940 });
  assert.equal(calls.length, 0);
});

test("onTokenExchange: refresh_token -> token Google rinnovato nei props, altri props invariati", async () => {
  const props = { userId: "owner", gate: 4, googleEmail: "nome@example.com", google: tokens };
  const r = await onTokenExchange("refresh_token", props, "CID", "S", NOW, fakeFetch(200, { access_token: "AT2", expires_in: 3599, scope: SCOPE }));
  assert.deepEqual(r, {
    newProps: { ...props, google: { accessToken: "AT2", expiresAt: NOW + 3599, refreshToken: "RT-FITTIZIO", scope: SCOPE } },
    accessTokenTTL: 3539,
  });
});

test("onTokenExchange: invalid_grant da Google -> errore (il grant va revocato)", async () => {
  await rejectsWith(onTokenExchange("refresh_token", { google: tokens }, "CID", "S", NOW, fakeFetch(400, { error: "invalid_grant" })), "invalid_grant");
});

test("onTokenExchange: errore temporaneo -> nessuna modifica (rinnovo rimandato al tool)", async () => {
  assert.equal(await onTokenExchange("refresh_token", { google: tokens }, "CID", "S", NOW, fakeFetch(503, {})), undefined);
  assert.equal(await onTokenExchange("refresh_token", { google: tokens }, "CID", "S", NOW, failingFetch), undefined);
});

test("hasGmailRead: readonly oppure modify (consenso granulare), nient'altro", () => {
  assert.equal(hasGmailRead(GMAIL_READONLY), true);
  assert.equal(hasGmailRead(`openid ${GMAIL_MODIFY}`), true);
  assert.equal(hasGmailRead("openid email https://www.googleapis.com/auth/gmail.compose"), false);
  assert.equal(hasGmailRead("https://mail.google.com/"), false);
});

test("tokensFromCodeExchange: concesso solo gmail.modify (readonly tolto nel consenso) -> accettato", () => {
  const r = tokensFromCodeExchange({ access_token: "A", expires_in: 3599, refresh_token: "R", scope: `openid ${GMAIL_MODIFY}` }, NOW);
  assert.equal(r.error, null);
  assert.equal(r.tokens?.scope, `openid ${GMAIL_MODIFY}`);
});

test("refreshGoogleTokens: con il solo gmail.modify il rinnovo resta valido", async () => {
  const r = await refreshGoogleTokens({ ...tokens, scope: GMAIL_MODIFY }, "CID", "S", NOW, fakeFetch(200, { access_token: "AT2", expires_in: 3599, scope: GMAIL_MODIFY }));
  assert.equal(r.accessToken, "AT2");
});
