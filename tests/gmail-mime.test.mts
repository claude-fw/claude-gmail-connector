// Test di src/gmail/mime.ts: base64url, charset, intestazioni, albero MIME, allegati, HTML -> testo, troncamento.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeBase64UrlBytes,
  decodeBase64UrlText,
  decodeBytes,
  decodeEntities,
  extractContent,
  header,
  headerParam,
  htmlToText,
  truncate,
  type GmailPart,
} from "../src/gmail/mime.ts";

const b64u = (s: string | Uint8Array) => Buffer.from(s).toString("base64url");

test("base64url: alfabeto URL-safe, con e senza padding, spazi ignorati", () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x41]);
  assert.deepEqual(decodeBase64UrlBytes(b64u(bytes)), bytes);
  assert.deepEqual(decodeBase64UrlBytes(Buffer.from(bytes).toString("base64")), bytes); // con + / =
  assert.equal(decodeBase64UrlText(b64u("ciao") + "\n"), "ciao");
});

test("base64url: testo UTF-8 con accenti ed emoji", () => {
  assert.equal(decodeBase64UrlText(b64u("Perché è così? 👍")), "Perché è così? 👍");
});

test("charset: ISO-8859-1 e windows-1252 decodificati correttamente", () => {
  const latin1 = new Uint8Array([0x50, 0x65, 0x72, 0x63, 0x68, 0xe9]); // "Perché" in latin-1
  assert.equal(decodeBytes(latin1, "ISO-8859-1"), "Perché");
  assert.equal(decodeBytes(new Uint8Array([0x80]), "windows-1252"), "€");
});

test("charset sconosciuto -> UTF-8", () => {
  assert.equal(decodeBytes(new TextEncoder().encode("è"), "x-sconosciuto"), "è");
});

test("header: case-insensitive, prima occorrenza, vuoto se assente", () => {
  const h = [{ name: "From", value: "A <a@example.com>" }, { name: "from", value: "B" }];
  assert.equal(header(h, "FROM"), "A <a@example.com>");
  assert.equal(header(h, "Subject"), "");
  assert.equal(header(undefined, "From"), "");
});

test("headerParam: valori con e senza virgolette", () => {
  assert.equal(headerParam('text/plain; charset="ISO-8859-1"', "charset"), "ISO-8859-1");
  assert.equal(headerParam("text/html; charset=utf-8; format=flowed", "charset"), "utf-8");
  assert.equal(headerParam("text/plain", "charset"), "");
});

const part = (mimeType: string, text: string, extra: Partial<GmailPart> = {}): GmailPart => ({
  mimeType,
  headers: [{ name: "Content-Type", value: `${mimeType}; charset=utf-8` }],
  body: { size: text.length, data: b64u(text) },
  ...extra,
});

test("extractContent: messaggio semplice text/plain", () => {
  const c = extractContent(part("text/plain", "Ciao Mario"));
  assert.equal(c.text, "Ciao Mario");
  assert.equal(c.html, null);
  assert.deepEqual(c.attachments, []);
});

test("extractContent: multipart/alternative con testo e HTML", () => {
  const c = extractContent({
    mimeType: "multipart/alternative",
    parts: [part("text/plain", "versione testo"), part("text/html", "<p>versione <b>html</b></p>")],
  });
  assert.equal(c.text, "versione testo");
  assert.equal(c.html, "<p>versione <b>html</b></p>");
});

test("extractContent: multipart/mixed annidato con allegati (solo metadati, nessun dato)", () => {
  const c = extractContent({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [part("text/plain", "corpo"), part("text/html", "<p>corpo</p>")] },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "fattura.pdf",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="fattura.pdf"' }],
        body: { size: 12345, attachmentId: "ATT-ID" },
      },
      {
        partId: "2",
        mimeType: "image/png",
        filename: "logo.png",
        headers: [{ name: "Content-Disposition", value: "inline" }],
        body: { size: 99, attachmentId: "ATT-2" },
      },
    ],
  });
  assert.equal(c.text, "corpo");
  assert.deepEqual(c.attachments, [
    { partId: "1", filename: "fattura.pdf", mimeType: "application/pdf", size: 12345, inline: false },
    { partId: "2", filename: "logo.png", mimeType: "image/png", size: 99, inline: true },
  ]);
});

test("extractContent: un .txt allegato non diventa corpo del messaggio", () => {
  const c = extractContent({
    mimeType: "multipart/mixed",
    parts: [
      part("text/plain", "corpo vero"),
      part("text/plain", "contenuto allegato", {
        partId: "1",
        filename: "note.txt",
        headers: [{ name: "Content-Disposition", value: "attachment" }],
      }),
    ],
  });
  assert.equal(c.text, "corpo vero");
  assert.equal(c.attachments[0].filename, "note.txt");
});

test("extractContent: allegato senza nome e parte vuota", () => {
  const c = extractContent({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { size: 0 } },
      { partId: "3", mimeType: "application/octet-stream", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { size: 5 } },
    ],
  });
  assert.equal(c.text, null);
  assert.equal(c.attachments[0].filename, "(senza nome)");
});

test("extractContent: charset della singola parte", () => {
  const latin = Buffer.from([0x63, 0x61, 0x66, 0xe8]).toString("base64url"); // "cafè" latin-1
  const c = extractContent({
    mimeType: "text/plain",
    headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }],
    body: { data: latin },
  });
  assert.equal(c.text, "cafè");
});

test("extractContent: payload assente", () => {
  assert.deepEqual(extractContent(undefined), { text: null, html: null, attachments: [] });
});

test("decodeEntities: nominali, numeriche, esadecimali, sconosciute invariate", () => {
  assert.equal(decodeEntities("&egrave; &amp; &#233; &#x1F44D; &foo; &#0;"), "è & é 👍 &foo; &#0;");
});

test("htmlToText: blocchi, a capo, liste, tabelle, entita'", () => {
  const t = htmlToText("<h1>Titolo</h1><p>Riga&nbsp;uno<br>Riga due</p><ul><li>a</li><li>b</li></ul><table><tr><td>x</td><td>y</td></tr></table>");
  assert.equal(t, "Titolo\n\nRiga uno\nRiga due\n\n- a\n- b\n\nx\ty");
});

test("htmlToText: rimuove script, style, head e commenti (nessun contenuto eseguibile)", () => {
  const t = htmlToText("<head><title>T</title><style>p{}</style></head><!-- nascosto --><script>alert(1)</script><p>visibile</p>");
  assert.equal(t, "visibile");
});

test("htmlToText: link resi come testo [url], solo http/https/mailto", () => {
  assert.equal(htmlToText('<a href="https://example.com/a?x=1&amp;y=2">Apri</a>'), "Apri [https://example.com/a?x=1&y=2]");
  assert.equal(htmlToText('<a href="https://example.com">https://example.com</a>'), "https://example.com");
  assert.equal(htmlToText('<a href="mailto:a@example.com">a@example.com</a>'), "mailto:a@example.com");
  assert.equal(htmlToText('<a href="javascript:alert(1)">Clicca</a>'), "Clicca");
  assert.equal(htmlToText("<a href='https://e.com'><img src=x></a>"), "https://e.com");
});

test("htmlToText: spazi e righe vuote compattati", () => {
  assert.equal(htmlToText("<div>a    b</div>\n\n\n\n<div>c</div>"), "a b\n\nc");
});

test("truncate: conta caratteri (non unita' UTF-16) e non spezza le emoji", () => {
  assert.deepEqual(truncate("abc", 5), { text: "abc", truncated: false, totalChars: 3 });
  assert.deepEqual(truncate("👍👍👍", 2), { text: "👍👍", truncated: true, totalChars: 3 });
});
