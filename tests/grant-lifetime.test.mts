// Durata del grant MCP con il VERO OAuthProvider installato (@cloudflare/workers-oauth-provider):
// registrazione client (DCR) -> consenso -> scambio del code (PKCE) -> refresh, con KV e orologio simulati.
// Dimostra che con REFRESH_TOKEN_IDLE_TTL_S ogni refresh OAuth sposta la scadenza del grant a 30 giorni da quel
// momento, mentre senza l'opzione la scadenza resta fissa a 30 giorni dal consenso; e che le chiamate API normali
// (senza refresh) non la spostano.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { REFRESH_TOKEN_IDLE_TTL_S } from "../src/instructions.ts";

// Il pacchetto importa `cloudflare:workers` (solo per WorkerEntrypoint): stub minimo, valido solo in questo test.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export class WorkerEntrypoint{};export class DurableObject{};export const env={};", shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { OAuthProvider } = await import("@cloudflare/workers-oauth-provider");

const DAY = 86400;
const BASE = "https://w.example";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

class FakeKV {
  data = new Map<string, { value: string; expiration?: number; metadata?: unknown }>();
  async get(key: string, opts?: unknown) {
    const e = this.data.get(key);
    if (!e) return null;
    const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
    return type === "json" ? JSON.parse(e.value) : e.value;
  }
  async put(key: string, value: string, opts: { expiration?: number; expirationTtl?: number; metadata?: unknown } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const expiration = opts.expiration ?? (opts.expirationTtl ? now + opts.expirationTtl : undefined);
    this.data.set(key, { value, expiration, metadata: opts.metadata });
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(opts: { prefix?: string } = {}) {
    const keys = [...this.data].filter(([k]) => k.startsWith(opts.prefix ?? "")).map(([name, e]) => ({ name, expiration: e.expiration, metadata: e.metadata }));
    return { keys, list_complete: true, cursor: "" };
  }
  grantExpiration(): number {
    const g = [...this.data].find(([k]) => k.startsWith("grant:"));
    assert.ok(g, "grant non trovato");
    return g[1].expiration!;
  }
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const b64u = (b: Buffer) => b.toString("base64url");

async function setup(idleTtl: number | undefined) {
  const kv = new FakeKV();
  const env = { OAUTH_KV: kv } as Record<string, unknown>;
  const provider = new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: { fetch: async () => new Response("ok") },
    defaultHandler: {
      // Consenso simulato: completa subito l'autorizzazione (in produzione lo fa src/auth.ts dopo Google).
      fetch: async (req: Request, e: { OAUTH_PROVIDER: { parseAuthRequest(r: Request): Promise<unknown>; completeAuthorization(o: unknown): Promise<{ redirectTo: string }> } }) => {
        const authReq = await e.OAUTH_PROVIDER.parseAuthRequest(req);
        const { redirectTo } = await e.OAUTH_PROVIDER.completeAuthorization({ request: authReq, userId: "owner", metadata: {}, scope: [], props: { google: "cifrato" } });
        return Response.redirect(redirectTo, 302);
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: { resource: `${BASE}/mcp` },
    ...(idleTtl !== undefined ? { refreshTokenIdleTTL: idleTtl } : {}),
  });
  const call = (req: Request) => provider.fetch(req, env, ctx);

  const reg = await (await call(new Request(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "test", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  }))).json() as { client_id: string };

  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const auth = await call(new Request(`${BASE}/authorize?` + new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "s", resource: `${BASE}/mcp`,
  })));
  const code = new URL(auth.headers.get("Location")!).searchParams.get("code")!;
  const tok = await (await call(new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
  }))).json() as { access_token: string; refresh_token: string };
  assert.ok(tok.refresh_token, "refresh token assente");

  const refresh = async (refreshToken: string) => {
    const r = await call(new Request(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: reg.client_id, resource: `${BASE}/mcp` }),
    }));
    return { status: r.status, body: (await r.json()) as { access_token?: string; refresh_token?: string; error?: string } };
  };
  const api = (accessToken: string) => call(new Request(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }));
  return { kv, tok, refresh, api };
}

test("configurazione: inattivita' massima del grant = 30 giorni", () => {
  assert.equal(REFRESH_TOKEN_IDLE_TTL_S, 30 * DAY);
});

test("con refreshTokenIdleTTL: ogni refresh sposta la scadenza del grant a 30 giorni da quel momento", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  try {
    const t0 = Math.floor(Date.now() / 1000);
    const s = await setup(REFRESH_TOKEN_IDLE_TTL_S);
    assert.equal(s.kv.grantExpiration(), t0 + 30 * DAY, "alla creazione: 30 giorni dal consenso");

    // Chiamata API normale con token valido (nessun refresh): risponde, ma la scadenza del grant NON si sposta.
    mock.timers.tick(10 * 60 * 1000);
    assert.equal((await s.api(s.tok.access_token)).status, 200);
    assert.equal(s.kv.grantExpiration(), t0 + 30 * DAY, "una chiamata API non rinnova il grant");

    // Refresh al giorno 20: la scadenza passa a giorno 20 + 30.
    mock.timers.tick(20 * DAY * 1000 - 10 * 60 * 1000);
    const r1 = await s.refresh(s.tok.refresh_token);
    assert.equal(r1.status, 200);
    assert.equal(s.kv.grantExpiration(), t0 + 50 * DAY);

    // Refresh al giorno 45 (oltre i 30 giorni dal consenso): il grant e' ancora valido e viene esteso di nuovo.
    mock.timers.tick(25 * DAY * 1000);
    const r2 = await s.refresh(r1.body.refresh_token!);
    assert.equal(r2.status, 200, "uso regolare: nessuna scadenza a 30 giorni fissi");
    assert.equal(s.kv.grantExpiration(), t0 + 75 * DAY);
  } finally {
    mock.timers.reset();
  }
});

test("con refreshTokenIdleTTL: dopo oltre 30 giorni di INATTIVITA' il grant scade (invalid_grant)", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  try {
    const s = await setup(REFRESH_TOKEN_IDLE_TTL_S);
    mock.timers.tick(31 * DAY * 1000);
    const r = await s.refresh(s.tok.refresh_token);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_grant");
  } finally {
    mock.timers.reset();
  }
});

test("SENZA l'opzione (comportamento precedente): scadenza fissa a 30 giorni dal consenso anche con refresh", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  try {
    const t0 = Math.floor(Date.now() / 1000);
    const s = await setup(undefined);
    mock.timers.tick(20 * DAY * 1000);
    const r1 = await s.refresh(s.tok.refresh_token);
    assert.equal(r1.status, 200);
    assert.equal(s.kv.grantExpiration(), t0 + 30 * DAY, "la scadenza non si sposta");
    mock.timers.tick(15 * DAY * 1000);
    const r2 = await s.refresh(r1.body.refresh_token!);
    assert.equal(r2.body.error, "invalid_grant", "al giorno 35 il grant e' scaduto nonostante l'uso");
  } finally {
    mock.timers.reset();
  }
});

test("src/index.ts passa l'opzione a OAuthProvider", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const options = src.slice(src.indexOf("export default new OAuthProvider"));
  assert.match(options, /refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_S,/);
});
