// Bozze del Gmail privato (scope gmail.compose; la lettura dell'originale per reply/forward richiede gmail.readonly).
// Nessuna funzione INVIA: si crea o modifica solo una bozza, che l'utente puo' rivedere e inviare da Gmail.
import { mapLimit, type GmailClient, type GmailMessage } from "./client.ts";
import {
  buildMime,
  combineBody,
  forwardSubject,
  forwardedText,
  parseAddressHeader,
  parseMessageIds,
  parseRecipients,
  quotedText,
  replyHeaders,
  toBase64Url,
  type Address,
  type MimeInput,
  type OriginalMessage,
} from "./compose.ts";
import { extractContent, header } from "./mime.ts";
import { GmailInputError } from "./query.ts";
import { bodyView, summarize } from "./view.ts";

export interface DraftContentInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
}

const fmt = (list: Address[]) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email));

function draftResult(draft: { id: string; message?: GmailMessage }, m: MimeInput, extra: Record<string, unknown> = {}) {
  return {
    draftId: draft.id,
    messageId: draft.message?.id ?? null,
    threadId: draft.message?.threadId ?? null,
    sent: false,
    note: "Bozza salvata nel Gmail privato e NON inviata. L'utente puo' rivederla e inviarla da Gmail.",
    to: fmt(m.to),
    cc: fmt(m.cc),
    bcc: fmt(m.bcc),
    subject: m.subject,
    ...extra,
  };
}

function requireBody(input: { text?: string; html?: string }) {
  if (input.text === undefined && input.html === undefined) throw new GmailInputError("testo_mancante");
}

export function originalFrom(msg: GmailMessage): OriginalMessage {
  const h = msg.payload?.headers;
  return {
    threadId: msg.threadId,
    from: header(h, "From"),
    replyTo: header(h, "Reply-To"),
    to: header(h, "To"),
    cc: header(h, "Cc"),
    subject: header(h, "Subject"),
    date: header(h, "Date"),
    messageIdHeader: header(h, "Message-ID"),
    references: header(h, "References"),
    bodyText: bodyView(msg, 20_000).body.text,
  };
}

/** Nuova bozza. */
export async function createDraft(client: GmailClient, input: DraftContentInput) {
  requireBody(input);
  const m: MimeInput = {
    to: parseRecipients(input.to),
    cc: parseRecipients(input.cc),
    bcc: parseRecipients(input.bcc),
    subject: input.subject ?? "",
    text: input.text,
    html: input.html,
  };
  const draft = await client.createDraft(toBase64Url(buildMime(m)));
  return draftResult(draft, m);
}

/** Risposta (o risposta a tutti) come bozza, nello stesso thread, con In-Reply-To/References. */
export async function createReplyDraft(
  client: GmailClient,
  self: string,
  input: { messageId: string; mode: "reply" | "reply_all"; text?: string; html?: string; includeQuote?: boolean; extraCc?: string[]; bcc?: string[] },
) {
  requireBody(input);
  const orig = originalFrom(await client.getMessage(input.messageId));
  const h = replyHeaders(orig, input.mode, self);
  if (h.to.length === 0) throw new GmailInputError("destinatario_mancante");
  const body = input.includeQuote === false ? { text: input.text, html: input.html } : combineBody(input, quotedText(orig), true);
  const m: MimeInput = {
    to: h.to,
    cc: [...h.cc, ...parseRecipients(input.extraCc)],
    bcc: parseRecipients(input.bcc),
    subject: h.subject,
    text: body.text,
    html: body.html,
    inReplyTo: h.inReplyTo,
    references: h.references,
  };
  const draft = await client.createDraft(toBase64Url(buildMime(m)), orig.threadId);
  return draftResult(draft, m, { inReplyToThread: orig.threadId });
}

/** Inoltro come bozza (nuovo thread). Gli allegati dell'originale NON vengono inclusi in questo blocco. */
export async function createForwardDraft(
  client: GmailClient,
  input: { messageId: string; to: string[]; cc?: string[]; bcc?: string[]; text?: string; html?: string },
) {
  const msg = await client.getMessage(input.messageId);
  const orig = originalFrom(msg);
  const to = parseRecipients(input.to);
  if (to.length === 0) throw new GmailInputError("destinatario_mancante");
  const body = combineBody({ text: input.text ?? "", html: input.html }, forwardedText(orig), false);
  const m: MimeInput = {
    to,
    cc: parseRecipients(input.cc),
    bcc: parseRecipients(input.bcc),
    subject: forwardSubject(orig.subject),
    text: body.text,
    html: body.html,
  };
  const draft = await client.createDraft(toBase64Url(buildMime(m)));
  const omitted = extractContent(msg.payload).attachments.filter((a) => !a.inline);
  return draftResult(draft, m, {
    originalAttachmentsNotIncluded: omitted.map((a) => a.filename),
  });
}

/**
 * Modifica di una bozza esistente: i campi indicati sostituiscono quelli attuali, gli altri restano.
 * Se si indica text e/o html, il corpo viene sostituito per intero. Threading (thread, In-Reply-To,
 * References) conservato.
 */
export async function updateDraft(client: GmailClient, input: DraftContentInput & { draftId: string }) {
  const current = await client.getDraft(input.draftId, "full");
  const msg = current.message;
  if (!msg) throw new GmailInputError("bozza_non_valida");
  const h = msg.payload?.headers;
  const content = extractContent(msg.payload);
  const replaceBody = input.text !== undefined || input.html !== undefined;
  const inReplyTo = parseMessageIds(header(h, "In-Reply-To"))[0];
  const m: MimeInput = {
    to: input.to !== undefined ? parseRecipients(input.to) : parseAddressHeader(header(h, "To")),
    cc: input.cc !== undefined ? parseRecipients(input.cc) : parseAddressHeader(header(h, "Cc")),
    bcc: input.bcc !== undefined ? parseRecipients(input.bcc) : parseAddressHeader(header(h, "Bcc")),
    subject: input.subject ?? header(h, "Subject"),
    text: replaceBody ? input.text : (content.text ?? undefined),
    html: replaceBody ? input.html : (content.html ?? undefined),
    inReplyTo,
    references: parseMessageIds(header(h, "References")),
  };
  if (m.text === undefined && m.html === undefined) m.text = "";
  const draft = await client.updateDraft(input.draftId, toBase64Url(buildMime(m)), msg.threadId);
  return draftResult(draft, m);
}

/** Elenco delle bozze con riepilogo (gmail.readonly). */
export async function listDrafts(client: GmailClient, opts: { maxResults?: number; pageToken?: string }) {
  const maxResults = Math.max(1, Math.min(25, Math.floor(opts.maxResults ?? 10)));
  const list = await client.listDrafts({ maxResults, pageToken: opts.pageToken });
  const names = new Map((await client.listLabels()).map((l) => [l.id, l.name]));
  const drafts = await mapLimit(list.drafts ?? [], 5, async (d) => {
    const full = await client.getDraft(d.id, "metadata");
    return { draftId: d.id, ...(full.message ? summarize(full.message, names) : {}) };
  });
  return { drafts, nextPageToken: list.nextPageToken ?? null };
}
