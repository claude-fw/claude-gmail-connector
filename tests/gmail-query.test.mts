// Test di src/gmail/query.ts e src/gmail/scopes.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailInputError, buildQuery, gmailDate, quoteValue } from "../src/gmail/query.ts";
import { GMAIL_SCOPES, scopeSatisfies } from "../src/gmail/scopes.ts";

const inputError = (code: string) => (e: unknown) => e instanceof GmailInputError && e.code === code;

test("buildQuery: nessun filtro -> query vuota", () => {
  assert.equal(buildQuery({}), "");
});

test("buildQuery: query nativa + filtri in AND, nell'ordine previsto", () => {
  assert.equal(
    buildQuery({
      query: "fattura",
      from: "banca@example.com",
      to: "me@example.com",
      subject: "Estratto conto",
      label: "Lavoro/Fatture",
      after: "2026-01-01",
      before: "2026-02-01",
      newerThanDays: 30,
      unread: true,
      starred: false,
      hasAttachment: true,
      folder: "inbox",
    }),
    'fattura from:banca@example.com to:me@example.com subject:"Estratto conto" label:Lavoro/Fatture ' +
      "after:2026/01/01 before:2026/02/01 newer_than:30d is:unread -is:starred has:attachment in:inbox",
  );
});

test("buildQuery: unread=false e hasAttachment=false", () => {
  assert.equal(buildQuery({ unread: false, hasAttachment: false }), "is:read -has:attachment");
});

test("buildQuery: a capo nella query nativa diventano spazi", () => {
  assert.equal(buildQuery({ query: "a\nb\r\nc" }), "a b c");
});

test("quoteValue: i valori non possono iniettare operatori", () => {
  assert.equal(quoteValue('Mario Rossi" OR from:altro'), '"Mario Rossi OR from:altro"');
  assert.equal(quoteValue("-escluso"), '"-escluso"');
  assert.equal(quoteValue("{a b}"), '"{a b}"');
  assert.equal(quoteValue("semplice"), "semplice");
  assert.throws(() => quoteValue('  " '), inputError("filtro_vuoto"));
});

test("gmailDate: formati accettati e date impossibili rifiutate", () => {
  assert.equal(gmailDate("2026-03-09"), "2026/03/09");
  assert.equal(gmailDate("2026/03/09"), "2026/03/09");
  assert.throws(() => gmailDate("2026-02-30"), inputError("data_non_valida"));
  assert.throws(() => gmailDate("09-03-2026"), inputError("data_non_valida"));
  assert.throws(() => gmailDate("2026-3-9"), inputError("data_non_valida"));
});

test("buildQuery: giorni non validi", () => {
  assert.throws(() => buildQuery({ newerThanDays: 0 }), inputError("giorni_non_validi"));
  assert.throws(() => buildQuery({ newerThanDays: 1.5 }), inputError("giorni_non_validi"));
});

test("scopeSatisfies: gerarchia degli scope Gmail", () => {
  const { readonly, modify, compose, send, labels } = GMAIL_SCOPES;
  assert.equal(scopeSatisfies(`openid ${readonly}`, readonly), true);
  assert.equal(scopeSatisfies(modify, readonly), true);
  assert.equal(scopeSatisfies(readonly, modify), false);
  assert.equal(scopeSatisfies(readonly, compose), false);
  assert.equal(scopeSatisfies(compose, send), true);
  assert.equal(scopeSatisfies(send, compose), false);
  assert.equal(scopeSatisfies(modify, labels), true);
  assert.equal(scopeSatisfies("", readonly), false);
  // mail.google.com non e' mai considerato: il codice non lo richiede ne' lo usa.
  assert.equal(scopeSatisfies("https://mail.google.com/", readonly), false);
});
