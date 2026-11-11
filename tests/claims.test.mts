// Test unitari di checkGoogleClaims (validazione dell'id_token Google). Solo dati FITTIZI.
// Esecuzione: npm test  (node --test, senza dipendenze: Node >= 24 esegue TypeScript direttamente)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGoogleClaims, redirectAllowed } from "../src/auth.ts";

const CID = "cid-fittizio.apps.googleusercontent.com";
const ALLOWED = "nome.cognome@example.com";
const now = 1_800_000_000;
const ok = {
  iss: "https://accounts.google.com",
  aud: CID,
  exp: now + 300,
  sub: "123",
  email: "nome.cognome@example.com",
  email_verified: true,
};

const cases: [string, Record<string, unknown> | null, string, string | null][] = [
  ["tutto valido", ok, ALLOWED, null],
  ["iss senza https (ammesso da Google)", { ...ok, iss: "accounts.google.com" }, ALLOWED, null],
  ["allowed con spazi, a capo e maiuscole", ok, "  Nome.Cognome@Example.COM\n", null],
  ["email del claim in maiuscolo", { ...ok, email: "Nome.Cognome@Example.com" }, ALLOWED, null],
  ["claims assenti", null, ALLOWED, "dati_mancanti"],
  ["sub mancante", { ...ok, sub: undefined }, ALLOWED, "dati_mancanti"],
  ["exp mancante", { ...ok, exp: undefined }, ALLOWED, "dati_mancanti"],
  ["email mancante", { ...ok, email: undefined }, ALLOWED, "dati_mancanti"],
  ["iss sbagliato", { ...ok, iss: "https://evil.example" }, ALLOWED, "iss"],
  ["aud sbagliato", { ...ok, aud: "altro-client" }, ALLOWED, "aud"],
  ["scaduto", { ...ok, exp: now - 1 }, ALLOWED, "scaduto"],
  ["scade esattamente ora", { ...ok, exp: now }, ALLOWED, "scaduto"],
  ["email non verificata", { ...ok, email_verified: false }, ALLOWED, "email_non_verificata"],
  ["email_verified come stringa", { ...ok, email_verified: "true" }, ALLOWED, "email_non_verificata"],
  ["email diversa", { ...ok, email: "altro@example.com" }, ALLOWED, "email_diversa"],
  ["dominio alternativo", { ...ok, email: "nome.cognome@example.org" }, ALLOWED, "email_diversa"],
  ["allowed vuoto", ok, "", "email_diversa"],
];

for (const [name, claims, allowed, want] of cases) {
  test(name, async () => {
    assert.equal(await checkGoogleClaims(claims, CID, allowed, now), want);
  });
}

// --- REGRESSIONE: redirect URI (Claude Code usa una porta loopback diversa a ogni sessione, RFC 8252) -----------

test("redirectAllowed: corrispondenza esatta (claude.ai)", () => {
  assert.equal(redirectAllowed(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectAllowed(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback/x"), false);
  assert.equal(redirectAllowed(["https://claude.ai/api/mcp/auth_callback"], "https://evil.example/api/mcp/auth_callback"), false);
});

test("redirectAllowed: loopback http con porta diversa ammessa (localhost, 127.0.0.1, [::1])", () => {
  assert.equal(redirectAllowed(["http://localhost:58695/callback"], "http://localhost:61234/callback"), true);
  assert.equal(redirectAllowed(["http://127.0.0.1/callback"], "http://127.0.0.1:3118/callback"), true);
  assert.equal(redirectAllowed(["http://[::1]:1/callback"], "http://[::1]:2/callback"), true);
});

test("redirectAllowed: loopback con host, percorso, query o schema diversi -> rifiutata", () => {
  const reg = ["http://localhost:58695/callback"];
  assert.equal(redirectAllowed(reg, "http://127.0.0.1:58695/callback"), false); // host diverso
  assert.equal(redirectAllowed(reg, "http://localhost:1/altro"), false);
  assert.equal(redirectAllowed(reg, "http://localhost:1/callback?x=1"), false);
  assert.equal(redirectAllowed(reg, "https://localhost:1/callback"), false);
  assert.equal(redirectAllowed(reg, "http://user:pw@localhost:1/callback"), false);
  assert.equal(redirectAllowed(reg, "http://localhost.evil.example:1/callback"), false);
  assert.equal(redirectAllowed(reg, "non-un-url"), false);
});

test("redirectAllowed: host non loopback con porta diversa -> rifiutata (nessuna tolleranza fuori da loopback)", () => {
  assert.equal(redirectAllowed(["http://example.com:80/cb"], "http://example.com:81/cb"), false);
  assert.equal(redirectAllowed(["https://claude.ai:443/cb"], "https://claude.ai:8443/cb"), false);
});
