// Test di src/gmail/compose.ts: indirizzi, RFC 2047, MIME (testo/HTML), header injection, reply/forward, threading.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMime,
  combineBody,
  dedupe,
  encodeHeaderText,
  encodeWords,
  formatAddress,
  forwardSubject,
  forwardedText,
  parseAddressHeader,
  parseMessageIds,
  parseRecipients,
  quotedText,
  replyHeaders,
  replySubject,
  toBase64Url,
  type MimeInput,
  type OriginalMessage,
} from "../src/gmail/compose.ts";
import { GmailInputError } from "../src/gmail/query.ts";

const inputError = (code: string) => (e: unknown) => e instanceof GmailInputError && e.code === code;

/** Decodifica una parola RFC 2047 B (per verificare l'andata e ritorno). */
const decodeWord = (w: string) => {
  const m = w.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
  assert.ok(m, w);
  return Buffer.from(m[1], "base64").toString("utf8");
};

/** Separazione intestazioni/corpo e decodifica delle parti base64 del MIME prodotto. */
function parseMime(mime: string) {
  assert.ok(!/(?<!\r)\n/.test(mime), "solo CRLF");
  const [head, ...rest] = mime.split("\r\n\r\n");
  const unfolded = head.replace(/\r\n[ \t]/g, " ");
  const headers = Object.fromEntries(unfolded.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
  const body = rest.join("\r\n\r\n");
  const parts: Record<string, string> = {};
  const decodePart = (block: string) => {
    const [ph, pb] = block.split("\r\n\r\n");
    const type = ph.match(/Content-Type: (text\/\w+)/)![1];
    const decoded = Buffer.from(pb.replace(/\r\n/g, ""), "base64").toString("utf8");
    assert.ok(!/(?<!\r)\n/.test(decoded), "parte di testo in forma canonica (solo CRLF)");
    parts[type] = decoded.replace(/\r\n/g, "\n");
  };
  const boundary = headers["Content-Type"]?.match(/boundary="([^"]+)"/)?.[1];
  if (boundary) {
    for (const block of body.split(`--${boundary}`).slice(1, -1)) decodePart(block.replace(/^\r\n|\r\n$/g, ""));
  } else {
    decodePart(`Content-Type: ${headers["Content-Type"]}\r\n\r\n${body.trim()}`);
  }
  return { headers, parts, raw: mime };
}

const base: MimeInput = { to: [{ name: "", email: "a@example.com" }], cc: [], bcc: [], subject: "Ciao", text: "Testo" };

// --- indirizzi ---------------------------------------------------------------------------------------------
test("parseRecipients: formati comuni, liste con virgole, nomi tra virgolette", () => {
  assert.deepEqual(parseRecipients(["a@example.com", "Mario Rossi <mario@example.it>", '"Rossi, Mario" <m@example.it>, b@example.org']), [
    { name: "", email: "a@example.com" },
    { name: "Mario Rossi", email: "mario@example.it" },
    { name: "Rossi, Mario", email: "m@example.it" },
    { name: "", email: "b@example.org" },
  ]);
});

test("parseRecipients: indirizzi non validi e a capo rifiutati", () => {
  for (const bad of ["non-email", "a@", "@b.com", "a b@c.com", "x@y.com\r\nBcc: evil@z.com", "Nome <senza-chiocciola>"]) {
    assert.throws(() => parseRecipients([bad]), inputError("indirizzo_non_valido"), bad);
  }
});

test("parseAddressHeader: tollerante (ignora 'undisclosed-recipients'), commenti, punto e virgola", () => {
  assert.deepEqual(parseAddressHeader("undisclosed-recipients:;"), []);
  assert.deepEqual(parseAddressHeader("a@example.com (Anna); \"B\" <b@example.com>"), [
    { name: "", email: "a@example.com" },
    { name: "B", email: "b@example.com" },
  ]);
});

test("dedupe: case-insensitive ed esclusioni", () => {
  const r = dedupe([{ name: "", email: "A@x.com" }, { name: "", email: "a@X.com" }, { name: "", email: "me@x.com" }], ["ME@x.com"]);
  assert.deepEqual(r.map((a) => a.email), ["A@x.com"]);
});

test("formatAddress: nome ASCII, nome con caratteri speciali, nome Unicode (RFC 2047)", () => {
  assert.equal(formatAddress({ name: "", email: "a@x.com" }), "a@x.com");
  assert.equal(formatAddress({ name: "Mario Rossi", email: "a@x.com" }), "Mario Rossi <a@x.com>");
  assert.equal(formatAddress({ name: 'Rossi, "Mario"', email: "a@x.com" }), '"Rossi, \\"Mario\\"" <a@x.com>');
  const u = formatAddress({ name: "Niccolò Città", email: "a@x.com" });
  assert.match(u, /^=\?UTF-8\?B\?.+\?= <a@x\.com>$/);
  assert.equal(decodeWord(u.split(" <")[0]), "Niccolò Città");
});

// --- RFC 2047 ----------------------------------------------------------------------------------------------
test("encodeWords: parole <= 75 caratteri, nessun carattere spezzato, andata e ritorno", () => {
  const s = "Perché è così difficile? 😀 ".repeat(8);
  const words = encodeWords(s);
  assert.ok(words.length > 1);
  for (const w of words) assert.ok(w.length <= 75, w);
  assert.equal(words.map(decodeWord).join(""), s);
});

test("encodeHeaderText: ASCII invariato, Unicode codificato e piegato, a capo rifiutati", () => {
  assert.equal(encodeHeaderText("Riunione di lunedi"), "Riunione di lunedi");
  assert.match(encodeHeaderText("Caffè ☕"), /^=\?UTF-8\?B\?/);
  assert.throws(() => encodeHeaderText("ok\r\nBcc: evil@x.com"), inputError("intestazione_non_valida"));
});

// --- MIME --------------------------------------------------------------------------------------------------
test("buildMime: solo testo -> text/plain UTF-8 base64, CRLF, intestazioni corrette", () => {
  const { headers, parts } = parseMime(buildMime({ ...base, cc: [{ name: "C", email: "c@x.com" }], bcc: [{ name: "", email: "b@x.com" }] }));
  assert.equal(headers.To, "a@example.com");
  assert.equal(headers.Cc, "C <c@x.com>");
  assert.equal(headers.Bcc, "b@x.com");
  assert.equal(headers.Subject, "Ciao");
  assert.equal(headers["MIME-Version"], "1.0");
  assert.equal(headers["Content-Type"], 'text/plain; charset="UTF-8"');
  assert.equal(headers["Content-Transfer-Encoding"], "base64");
  assert.equal(parts["text/plain"], "Testo");
  assert.equal(headers.From, undefined); // lo aggiunge Gmail
});

test("buildMime: testo + HTML -> multipart/alternative con entrambe le parti", () => {
  const { headers, parts } = parseMime(buildMime({ ...base, text: "Ciao ✓", html: "<p>Ciao <b>✓</b></p>" }, "BOUNDARY"));
  assert.equal(headers["Content-Type"], 'multipart/alternative; boundary="BOUNDARY"');
  assert.equal(parts["text/plain"], "Ciao ✓");
  assert.equal(parts["text/html"], "<p>Ciao <b>✓</b></p>");
});

test("buildMime: solo HTML -> versione testo ricavata dall'HTML", () => {
  const { parts } = parseMime(buildMime({ ...base, text: undefined, html: "<p>Uno</p><p>Due</p>" }, "B"));
  assert.equal(parts["text/plain"], "Uno\n\nDue");
});

test("buildMime: Unicode ovunque (oggetto, nomi, corpo) e righe base64 <= 76", () => {
  const mime = buildMime({ ...base, to: [{ name: "Zoë Ünal", email: "z@x.com" }], subject: "Oggetto con àèìòù e 日本語", text: "Corpo 👍 ".repeat(200) });
  const { headers, parts } = parseMime(mime);
  assert.equal(headers.Subject.split(" ").map(decodeWord).join(""), "Oggetto con àèìòù e 日本語");
  assert.equal(parts["text/plain"], "Corpo 👍 ".repeat(200));
  for (const line of mime.split("\r\n")) assert.ok(line.length <= 998, "riga troppo lunga");
  const bodyLines = mime.split("\r\n\r\n")[1].split("\r\n").filter(Boolean);
  for (const l of bodyLines) assert.ok(l.length <= 76);
});

test("buildMime: molti destinatari piegati su piu' righe", () => {
  const to = Array.from({ length: 30 }, (_, i) => ({ name: `Persona ${i}`, email: `p${i}@example.com` }));
  const mime = buildMime({ ...base, to });
  const toBlock = mime.split("\r\nSubject:")[0];
  assert.ok(toBlock.split("\r\n").length >= 30);
  assert.equal(parseMime(mime).headers.To.split(", ").length, 30);
});

test("buildMime: In-Reply-To e References", () => {
  const { headers } = parseMime(buildMime({ ...base, inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"] }));
  assert.equal(headers["In-Reply-To"], "<b@x>");
  assert.equal(headers.References, "<a@x> <b@x>");
});

test("buildMime: limiti e valori non validi", () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ name: "", email: `p${i}@x.com` }));
  assert.throws(() => buildMime({ ...base, to: many }), inputError("troppi_destinatari"));
  assert.throws(() => buildMime({ ...base, subject: "x".repeat(501) }), inputError("oggetto_troppo_lungo"));
  assert.throws(() => buildMime({ ...base, inReplyTo: "<a@x>\r\nBcc: e@x" }), inputError("intestazione_non_valida"));
  assert.throws(() => buildMime({ ...base, references: ["senza-parentesi"] }), inputError("intestazione_non_valida"));
  assert.throws(() => buildMime({ ...base, to: [{ name: "x\ny", email: "a@x.com" }] }), inputError("intestazione_non_valida"));
});

test("toBase64Url: alfabeto URL-safe senza padding, andata e ritorno", () => {
  const mime = buildMime({ ...base, text: "àèì ??? >>> ~~~" });
  const raw = toBase64Url(mime);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(raw));
  assert.equal(Buffer.from(raw, "base64url").toString("utf8"), mime);
});

// --- reply / forward -----------------------------------------------------------------------------------------
const orig: OriginalMessage = {
  threadId: "T1",
  from: "Anna <anna@example.com>",
  replyTo: "",
  to: "Me <me@example.com>, Bob <bob@example.com>",
  cc: "carla@example.com, ME@example.com",
  subject: "Pranzo",
  date: "Mon, 5 Oct 2026 10:00:00 +0200",
  messageIdHeader: "<m3@mail.example.com>",
  references: "<m1@mail.example.com> <m2@mail.example.com>",
  bodyText: "Ci vediamo?\nA presto",
};

test("replySubject / forwardSubject: prefissi non duplicati (anche italiani)", () => {
  assert.equal(replySubject("Pranzo"), "Re: Pranzo");
  assert.equal(replySubject("RE: Pranzo"), "RE: Pranzo");
  assert.equal(replySubject("R: Pranzo"), "R: Pranzo");
  assert.equal(forwardSubject("Pranzo"), "Fwd: Pranzo");
  assert.equal(forwardSubject("I: Pranzo"), "I: Pranzo");
  assert.equal(forwardSubject("Fw: Pranzo"), "Fw: Pranzo");
});

test("replyHeaders reply: solo l'autore, threading completo", () => {
  const h = replyHeaders(orig, "reply", "me@example.com");
  assert.deepEqual(h.to, [{ name: "Anna", email: "anna@example.com" }]);
  assert.deepEqual(h.cc, []);
  assert.equal(h.subject, "Re: Pranzo");
  assert.equal(h.inReplyTo, "<m3@mail.example.com>");
  assert.deepEqual(h.references, ["<m1@mail.example.com>", "<m2@mail.example.com>", "<m3@mail.example.com>"]);
});

test("replyHeaders reply_all: tutti tranne se stessi (case-insensitive) e senza duplicare l'autore", () => {
  const h = replyHeaders({ ...orig, cc: orig.cc + ", anna@example.com" }, "reply_all", "me@example.com");
  assert.deepEqual(h.to.map((a) => a.email), ["anna@example.com"]);
  assert.deepEqual(h.cc.map((a) => a.email), ["bob@example.com", "carla@example.com"]);
});

test("replyHeaders: Reply-To ha la precedenza sul mittente", () => {
  const h = replyHeaders({ ...orig, replyTo: "Lista <lista@example.com>" }, "reply", "me@example.com");
  assert.deepEqual(h.to.map((a) => a.email), ["lista@example.com"]);
});

test("replyHeaders: risposta a una propria email -> destinatari originali", () => {
  const h = replyHeaders({ ...orig, from: "Me <me@example.com>", to: "Bob <bob@example.com>" }, "reply", "me@example.com");
  assert.deepEqual(h.to.map((a) => a.email), ["bob@example.com"]);
});

test("replyHeaders: References limitate alle ultime 20, senza duplicati", () => {
  const many = Array.from({ length: 30 }, (_, i) => `<r${i}@x>`).join(" ");
  const h = replyHeaders({ ...orig, references: many + " <m3@mail.example.com>" }, "reply", "me@example.com");
  assert.equal(h.references.length, 20);
  assert.equal(h.references.at(-1), "<m3@mail.example.com>");
  assert.equal(new Set(h.references).size, 20);
});

test("parseMessageIds: solo id tra <>", () => {
  assert.deepEqual(parseMessageIds("<a@x> garbage <b@y>\r\n <c@z>"), ["<a@x>", "<b@y>", "<c@z>"]);
});

test("quotedText / forwardedText / combineBody", () => {
  assert.equal(quotedText(orig), "Il giorno Mon, 5 Oct 2026 10:00:00 +0200 Anna <anna@example.com> ha scritto:\n> Ci vediamo?\n> A presto");
  const f = forwardedText(orig);
  assert.match(f, /^---------- Messaggio inoltrato ----------\nDa: Anna <anna@example\.com>\n/);
  assert.match(f, /Oggetto: Pranzo/);
  assert.match(f, /Ci vediamo\?\nA presto$/);
  const plain = combineBody({ text: "Si'!" }, "BLOCCO", true);
  assert.deepEqual(plain, { text: "Si'!\n\nBLOCCO" });
  const withHtml = combineBody({ html: "<p>Si'!</p>" }, "<script>x</script>", true);
  assert.match(withHtml.html!, /<blockquote[^>]*><div[^>]*>&lt;script&gt;x&lt;\/script&gt;<\/div><\/blockquote>$/);
  assert.match(withHtml.text, /^Si'!\n\n<script>x<\/script>$/);
});

test("REGRESSIONE replyHeaders: email da se stessi a se stessi -> risposta a se stessi (come Gmail)", () => {
  const h = replyHeaders({ ...orig, from: "Me <me@example.com>", to: "me@example.com", cc: "" }, "reply", "me@example.com");
  assert.deepEqual(h.to.map((a) => a.email), ["me@example.com"]);
  assert.deepEqual(h.cc, []);
  const all = replyHeaders({ ...orig, from: "Me <me@example.com>", to: "me@example.com", cc: "" }, "reply_all", "me@example.com");
  assert.deepEqual(all.to.map((a) => a.email), ["me@example.com"]);
  assert.deepEqual(all.cc, []);
});

test("REGRESSIONE replyHeaders: propria email ad altri, rispondi a tutti -> nessun indirizzo ripetuto tra A e Cc", () => {
  const h = replyHeaders({ ...orig, from: "Me <me@example.com>", to: "Bob <bob@example.com>", cc: "carla@example.com" }, "reply_all", "me@example.com");
  assert.deepEqual(h.to.map((a) => a.email), ["bob@example.com"]);
  assert.deepEqual(h.cc.map((a) => a.email), ["carla@example.com"]);
});
