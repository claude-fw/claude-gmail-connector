// Invio email dal Gmail PRIVATO: SOLO l'invio di una bozza esistente (drafts.send), SEMPRE con conferma fuori banda.
//
// PREPARA (private_gmail_prepare_send): legge la bozza, valida destinatari/oggetto/corpo/dimensione, registra
//   l'id del messaggio della bozza e lo SHA-256 del suo contenuto completo (format=raw), crea un'azione in attesa
//   con un'anteprima generata dal server. NON invia.
// CONFERMA: pagina /confirm/<id> nel browser con CONFIRM_PASSPHRASE (il modello non puo' farlo).
// ESEGUI (private_gmail_execute_action): rilegge la bozza e invia SOLO se e' identica a quella confermata
//   (stesso id messaggio e stesso SHA-256); il Durable Object garantisce al massimo un'esecuzione.
//
// Scope: drafts.send accetta gmail.compose o gmail.modify (non gmail.send): basta gmail.modify gia' concesso.
// Errori: 4xx = sicuramente NON inviata; rete/timeout/5xx = esito incerto (mai ritentato: controllare "Inviata").
import { GoogleError } from "../google.ts";
import { sha256Hex } from "../web.ts";
import type { ActionBackend, SendPreview } from "../actions/store.ts";
import type { GmailClient } from "./client.ts";
import { parseRecipients, type Address } from "./compose.ts";
import { header } from "./mime.ts";
import { confirmationInfo } from "./organize.ts";
import { GmailInputError } from "./query.ts";
import { bodyView } from "./view.ts";

export const SEND_LIMITS = {
  recipientsMax: 100,
  /** Limite di Gmail per un messaggio (allegati compresi). */
  messageBytesMax: 25 * 1024 * 1024,
  previewBodyChars: 2000,
} as const;

export interface SendDraftPayload {
  draftId: string;
  /** Id del messaggio della bozza al momento della preparazione (cambia a ogni modifica della bozza). */
  messageId: string;
  threadId: string;
  /** SHA-256 del messaggio completo (format=raw) al momento della preparazione. */
  rawSha256: string;
  recipients: number;
}

/** Invio con esito incerto (rete/timeout/5xx dopo la richiesta): non va MAI ritentato automaticamente. */
export class SendUncertainError extends Error {
  readonly code = "invio_esito_incerto";
  constructor() {
    super("invio_esito_incerto");
    this.name = "SendUncertainError";
  }
}

const fmt = (list: Address[]) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email));

/** Validazione e anteprima della bozza (dati di Gmail, verificati in modo rigoroso). */
export function validateDraftForSend(draft: Awaited<ReturnType<GmailClient["getDraft"]>>) {
  const msg = draft.message;
  if (!msg?.id) throw new GmailInputError("bozza_non_valida");
  const h = msg.payload?.headers;
  // Rigoroso: un solo indirizzo non valido blocca l'invio.
  const to = parseRecipients([header(h, "To")].filter(Boolean));
  const cc = parseRecipients([header(h, "Cc")].filter(Boolean));
  const bcc = parseRecipients([header(h, "Bcc")].filter(Boolean));
  const total = to.length + cc.length + bcc.length;
  if (total === 0) throw new GmailInputError("destinatario_mancante");
  if (total > SEND_LIMITS.recipientsMax) throw new GmailInputError("troppi_destinatari");
  const subject = header(h, "Subject").trim();
  if (!subject) throw new GmailInputError("oggetto_mancante");
  const { body, attachments } = bodyView(msg, SEND_LIMITS.previewBodyChars);
  if (body.format === "nessuno" && attachments.length === 0) throw new GmailInputError("testo_mancante");
  if ((msg.sizeEstimate ?? 0) > SEND_LIMITS.messageBytesMax) throw new GmailInputError("messaggio_troppo_grande");
  const preview: SendPreview = {
    to: fmt(to),
    cc: fmt(cc),
    bcc: fmt(bcc),
    subject,
    bodyExcerpt: body.text,
    bodyTruncated: body.truncated,
    attachments: attachments.filter((a) => !a.inline).map((a) => a.filename),
    isReply: header(h, "In-Reply-To") !== "",
  };
  return { msg, preview, total };
}

/** Prepara l'invio di una bozza: valida, fotografa il contenuto, crea l'azione da confermare. NON invia. */
export async function prepareSendDraft(
  client: GmailClient,
  store: ActionBackend,
  ctx: { googleSub: string; confirmBase: string; now: number },
  input: { draftId: string },
) {
  const draft = await client.getDraft(input.draftId, "full");
  const { msg, preview, total } = validateDraftForSend(draft);
  const raw = await client.getDraftRaw(input.draftId);
  // Il contenuto validato e quello fotografato devono essere lo stesso messaggio.
  if (!raw.message?.raw || raw.message.id !== msg.id) throw new GmailInputError("bozza_modificata");
  const payload: SendDraftPayload = {
    draftId: input.draftId,
    messageId: msg.id,
    threadId: msg.threadId,
    rawSha256: await sha256Hex(raw.message.raw),
    recipients: total,
  };
  const summary =
    `INVIA un'email dal Gmail privato a ${total} ${total === 1 ? "destinatario" : "destinatari"}` +
    `${preview.isReply ? " (risposta in una conversazione esistente)" : ""}. L'invio NON e' reversibile.`;
  const { id, action } = await store.create(
    { kind: "send_draft", googleSub: ctx.googleSub, summary, total, samples: [], preview, payload },
    ctx.now,
  );
  return { executed: false, sent: false, summary, preview, confirmation: confirmationInfo(id, ctx.confirmBase, action.confirmBy, summary) };
}

/** Esecuzione (solo da executeAction, dopo conferma): verifica di integrita', poi drafts.send. */
export async function executeSendDraft(client: GmailClient, p: SendDraftPayload) {
  let current;
  try {
    current = await client.getDraftRaw(p.draftId);
  } catch (e) {
    // La bozza non esiste piu' (eliminata o gia' inviata): non si invia nulla.
    if (e instanceof GoogleError && e.code === "gmail_non_trovato") throw new GmailInputError("bozza_non_trovata");
    throw e;
  }
  const raw = current.message?.raw;
  if (!raw || current.message?.id !== p.messageId || (await sha256Hex(raw)) !== p.rawSha256) {
    throw new GmailInputError("bozza_modificata");
  }
  let sent;
  try {
    sent = await client.sendDraft(p.draftId);
  } catch (e) {
    // gmail_errore = rete, timeout, 5xx o risposta illeggibile: Google potrebbe aver inviato. Mai ritentare.
    if (e instanceof GoogleError && e.code === "gmail_errore") throw new SendUncertainError();
    throw e; // 400/401/403/404/429: richiesta rifiutata, email NON inviata
  }
  return { sent: true, messageId: sent?.id ?? null, threadId: sent?.threadId ?? null, recipients: p.recipients };
}
