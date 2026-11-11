// Composizione di messaggi RFC 5322 per le BOZZE (qui nessun invio; l'invio e' solo in src/gmail/send.ts): indirizzi, intestazioni RFC 2047 (UTF-8),
// corpo testo/HTML (multipart/alternative), threading (In-Reply-To/References), reply/reply-all/forward.
// Funzioni pure: nessuna rete. Ogni valore che finisce in un'intestazione e' validato contro CR/LF (header injection).
import { htmlToText } from "./mime.ts";
import { GmailInputError } from "./query.ts";
import { esc } from "../web.ts";

export interface Address {
  name: string;
  email: string;
}

export const COMPOSE_LIMITS = {
  recipientsMax: 100,
  subjectMax: 500,
  bodyMax: 500_000,
  referencesMax: 20,
  quoteMax: 20_000,
} as const;

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

function noControl(s: string, code = "intestazione_non_valida"): string {
  if (/[\r\n\0]/.test(s)) throw new GmailInputError(code);
  return s;
}

/** Divide una lista di indirizzi sulle virgole fuori da virgolette, <> e commenti. */
function splitAddresses(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\" && quoted) {
      cur += c + (input[++i] ?? "");
      continue;
    }
    if (c === '"' && !angle && !paren) quoted = !quoted;
    else if (!quoted) {
      if (c === "<") angle++;
      else if (c === ">" && angle) angle--;
      else if (c === "(") paren++;
      else if (c === ")" && paren) paren--;
      else if ((c === "," || c === ";") && !angle && !paren) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function unquoteName(name: string): string {
  let n = name.trim();
  if (n.startsWith('"') && n.endsWith('"') && n.length >= 2) n = n.slice(1, -1).replace(/\\(.)/g, "$1");
  return n.replace(/\s+/g, " ").trim();
}

function parseOne(item: string): Address | null {
  const m = item.match(/^(.*?)<\s*([^<>\s]+)\s*>\s*(?:\(.*\))?$/s);
  const email = (m ? m[2] : item.replace(/\(.*?\)/g, "")).trim();
  if (!isValidEmail(email)) return null;
  return { name: m ? unquoteName(m[1]) : "", email };
}

/**
 * Indirizzi da un'intestazione esistente (From/To/Cc di un'email ricevuta): tollerante,
 * gli elementi non validi (es. "undisclosed-recipients:;") vengono ignorati.
 */
export function parseAddressHeader(value: string): Address[] {
  return splitAddresses(value).map(parseOne).filter((a): a is Address => a !== null);
}

/** Indirizzi forniti dall'utente: rigorosi, qualsiasi elemento non valido e' un errore. */
export function parseRecipients(items: string[] | undefined): Address[] {
  const out: Address[] = [];
  for (const raw of items ?? []) {
    noControl(raw, "indirizzo_non_valido");
    for (const part of splitAddresses(raw)) {
      const a = parseOne(part);
      if (!a) throw new GmailInputError("indirizzo_non_valido");
      out.push(a);
    }
  }
  return out;
}

/** Rimuove i duplicati (per indirizzo, case-insensitive) e gli indirizzi esclusi. */
export function dedupe(list: Address[], exclude: Iterable<string> = []): Address[] {
  const seen = new Set([...exclude].map((e) => e.toLowerCase()));
  return list.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 "B" in UTF-8, parole codificate di al massimo 75 caratteri, senza spezzare i caratteri. */
export function encodeWords(s: string): string[] {
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (!chunk.length) return;
    words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...chunk))}?=`);
    chunk = [];
  };
  for (const ch of Array.from(s)) {
    const bytes = [...new TextEncoder().encode(ch)];
    if (chunk.length + bytes.length > 45) flush(); // 45 byte -> 60 caratteri base64 -> 72 con il prefisso
    chunk.push(...bytes);
  }
  flush();
  return words;
}

/** Valore di intestazione non strutturata (es. Subject): ASCII invariato, altrimenti RFC 2047 piegato. */
export function encodeHeaderText(s: string): string {
  noControl(s);
  return isAscii(s) ? s : encodeWords(s).join("\r\n ");
}

export function formatAddress(a: Address): string {
  noControl(a.name);
  if (!isValidEmail(a.email)) throw new GmailInputError("indirizzo_non_valido");
  if (!a.name) return a.email;
  if (!isAscii(a.name)) return `${encodeWords(a.name).join(" ")} <${a.email}>`;
  const needsQuote = /[()<>\[\]:;@\\,."]/.test(a.name);
  return `${needsQuote ? `"${a.name.replace(/(["\\])/g, "\\$1")}"` : a.name} <${a.email}>`;
}

function addressHeader(name: string, list: Address[]): string | null {
  return list.length ? `${name}: ${list.map(formatAddress).join(",\r\n ")}` : null;
}

/** Message-ID nel formato <...>: solo questi finiscono in In-Reply-To/References. */
export function parseMessageIds(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) ?? [];
}

function base64Lines(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return (btoa(bin).match(/.{1,76}/g) ?? [""]).join("\r\n");
}

function randomBoundary(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return `=_pgm_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export interface MimeInput {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

export function validateMimeInput(m: MimeInput): void {
  if (m.to.length + m.cc.length + m.bcc.length > COMPOSE_LIMITS.recipientsMax) throw new GmailInputError("troppi_destinatari");
  if (Array.from(m.subject).length > COMPOSE_LIMITS.subjectMax) throw new GmailInputError("oggetto_troppo_lungo");
  if ((m.text?.length ?? 0) + (m.html?.length ?? 0) > COMPOSE_LIMITS.bodyMax) throw new GmailInputError("testo_troppo_lungo");
  if (m.inReplyTo !== undefined && !/^<[^<>\s]+>$/.test(m.inReplyTo)) throw new GmailInputError("intestazione_non_valida");
  for (const r of m.references ?? []) if (!/^<[^<>\s]+>$/.test(r)) throw new GmailInputError("intestazione_non_valida");
}

/**
 * Messaggio RFC 5322 completo (CRLF). From/Date/Message-ID li aggiunge Gmail.
 * Solo testo -> text/plain; con HTML -> multipart/alternative (testo ricavato dall'HTML se assente).
 */
export function buildMime(m: MimeInput, boundary = randomBoundary()): string {
  validateMimeInput(m);
  const headers = [
    addressHeader("To", m.to),
    addressHeader("Cc", m.cc),
    addressHeader("Bcc", m.bcc),
    `Subject: ${encodeHeaderText(m.subject)}`,
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : null,
    m.references?.length ? `References: ${m.references.join("\r\n ")}` : null,
    "MIME-Version: 1.0",
  ].filter((h): h is string => h !== null);

  // RFC 2046: le parti text/* si codificano in forma canonica, con a capo CRLF, prima del base64.
  const textPart = (body: string, sub: "plain" | "html") =>
    [
      `Content-Type: text/${sub}; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(body.replace(/\r?\n/g, "\r\n")),
    ].join("\r\n");

  if (m.html === undefined) {
    return [...headers, textPart(m.text ?? "", "plain")].join("\r\n") + "\r\n";
  }
  const text = m.text ?? htmlToText(m.html);
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    textPart(text, "plain"),
    `--${boundary}`,
    textPart(m.html, "html"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export function toBase64Url(mime: string): string {
  const bytes = new TextEncoder().encode(mime);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- reply / forward ----------------------------------------------------------------------------------------------

/** Dati dell'email originale necessari a reply/forward (ricavati da messages.get). */
export interface OriginalMessage {
  threadId: string;
  from: string;
  replyTo: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  messageIdHeader: string;
  references: string;
  bodyText: string;
}

export function replySubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, " ").trim();
  return /^\s*(re|r|aw|sv|rif)\s*:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, " ").trim();
  return /^\s*(fwd?|i|inoltro)\s*:/i.test(s) ? s : `Fwd: ${s}`;
}

/** Destinatari e intestazioni di threading di una risposta. `self` = indirizzo dell'account (escluso). */
export function replyHeaders(orig: OriginalMessage, mode: "reply" | "reply_all", self: string) {
  const author = parseAddressHeader(orig.replyTo || orig.from);
  let to = dedupe(author, [self]);
  // Risposta a una propria email: ai destinatari originali; se era scritta solo a se stessi, a se stessi (come Gmail).
  if (!to.length) to = dedupe(parseAddressHeader(orig.to), [self]);
  if (!to.length) to = dedupe(parseAddressHeader(orig.to));
  if (!to.length) to = dedupe(author);
  // Il Cc si calcola DOPO il destinatario definitivo: nessun indirizzo ripetuto tra A e Cc.
  const cc =
    mode === "reply_all"
      ? dedupe([...parseAddressHeader(orig.to), ...parseAddressHeader(orig.cc)], [self, ...to.map((a) => a.email)])
      : [];
  const finalTo = to;
  const ownId = parseMessageIds(orig.messageIdHeader)[0];
  const refs = [...parseMessageIds(orig.references), ...(ownId ? [ownId] : [])];
  return {
    to: finalTo,
    cc,
    subject: replySubject(orig.subject),
    inReplyTo: ownId,
    references: [...new Set(refs)].slice(-COMPOSE_LIMITS.referencesMax),
  };
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("") + "\n[…]";
}

export function quotedText(orig: OriginalMessage): string {
  const body = clip(orig.bodyText.replace(/\r\n?/g, "\n").trim(), COMPOSE_LIMITS.quoteMax);
  const intro = `Il giorno ${orig.date || "(data sconosciuta)"} ${orig.from || "(mittente sconosciuto)"} ha scritto:`;
  return `${intro}\n${body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}`;
}

export function forwardedText(orig: OriginalMessage): string {
  const body = clip(orig.bodyText.replace(/\r\n?/g, "\n").trim(), COMPOSE_LIMITS.quoteMax);
  return [
    "---------- Messaggio inoltrato ----------",
    `Da: ${orig.from}`,
    `Data: ${orig.date}`,
    `Oggetto: ${orig.subject}`,
    `A: ${orig.to}`,
    ...(orig.cc ? [`Cc: ${orig.cc}`] : []),
    "",
    body,
  ].join("\n");
}

/** Corpo di reply/forward: testo dell'utente + blocco originale (testo e, se c'e' HTML, versione HTML). */
export function combineBody(user: { text?: string; html?: string }, block: string, asQuote: boolean) {
  const text = `${user.text ?? (user.html !== undefined ? htmlToText(user.html) : "")}\n\n${block}`;
  if (user.html === undefined) return { text };
  const blockHtml = `<div style="white-space:pre-wrap">${esc(block)}</div>`;
  const html = `${user.html}<br><br>${asQuote ? `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${blockHtml}</blockquote>` : blockHtml}`;
  return { text, html };
}
