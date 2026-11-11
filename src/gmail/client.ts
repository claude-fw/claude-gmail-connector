// Client minimale della Gmail API (users/me). Solo chiamate e tipi della risposta: la logica e' in view.ts,
// organize.ts e drafts.ts. Ogni metodo dichiara lo scope minimo Gmail che richiede (vedi scopes.ts).
// Invio: SOLO sendDraft (drafts.send), chiamato esclusivamente da src/gmail/send.ts dopo una conferma fuori banda.
// Nessun messages.send, nessuna cancellazione (DELETE).
import { gmailRequest } from "../google.ts";
import type { GmailHeader, GmailPart } from "./mime.ts";
import { GmailInputError } from "./query.ts";

type FetchFn = typeof fetch;

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

export interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
}

/** Intestazioni richieste nel formato "metadata" (elenchi di risultati). */
export const LIST_HEADERS = ["From", "To", "Cc", "Subject", "Date"];

/** Gli id di Gmail sono stringhe esadecimali/base64url: niente altro puo' finire nel path della richiesta. */
export function validateId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new GmailInputError("id_non_valido");
  return id;
}

/** Esegue `fn` sugli elementi con al massimo `limit` chiamate contemporanee, mantenendo l'ordine. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class GmailClient {
  private labelsCache: Promise<GmailLabel[]> | null = null;
  // Campi espliciti (non "parameter properties"): Node esegue i test TypeScript in modalita' strip-only.
  private readonly accessToken: string;
  private readonly fetchImpl: FetchFn;

  constructor(accessToken: string, fetchImpl: FetchFn = fetch) {
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
  }

  private get<T>(path: string, query?: Record<string, string | number | boolean | string[] | undefined>) {
    return gmailRequest<T>(this.accessToken, "GET", path, { query }, this.fetchImpl);
  }

  private write<T>(method: "POST" | "PUT", path: string, body?: unknown) {
    return gmailRequest<T>(this.accessToken, method, path, { body }, this.fetchImpl);
  }

  /** messages.list (gmail.readonly). */
  listMessages(opts: { q: string; maxResults: number; pageToken?: string; includeSpamTrash?: boolean }) {
    return this.get<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
      "/messages",
      {
        q: opts.q || undefined,
        maxResults: opts.maxResults,
        pageToken: opts.pageToken,
        includeSpamTrash: opts.includeSpamTrash || undefined,
      },
    );
  }

  /** messages.get format=metadata, solo le intestazioni utili agli elenchi (gmail.readonly). */
  getMessageMetadata(id: string) {
    return this.get<GmailMessage>(`/messages/${validateId(id)}`, { format: "metadata", metadataHeaders: LIST_HEADERS });
  }

  /** messages.get format=full (gmail.readonly). */
  getMessage(id: string) {
    return this.get<GmailMessage>(`/messages/${validateId(id)}`, { format: "full" });
  }

  /** threads.get format=full (gmail.readonly). */
  getThread(id: string) {
    return this.get<GmailThread>(`/threads/${validateId(id)}`, { format: "full" });
  }

  /** threads.get format=metadata: intestazioni essenziali dei messaggi del thread, per le anteprime (gmail.readonly). */
  getThreadMetadata(id: string) {
    return this.get<GmailThread>(`/threads/${validateId(id)}`, { format: "metadata", metadataHeaders: ["From", "Subject"] });
  }

  /** threads.get format=minimal: solo id e label dei messaggi del thread (gmail.readonly). */
  getThreadMinimal(id: string) {
    return this.get<GmailThread>(`/threads/${validateId(id)}`, { format: "minimal" });
  }

  /**
   * messages.batchModify (gmail.modify): UNA chiamata per tutti gli id, quindi nessuna esecuzione parziale lato
   * client. Massimo 1000 id per chiamata (limite Gmail).
   */
  batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]) {
    if (ids.length === 0 || ids.length > 1000) throw new GmailInputError("numero_elementi_non_valido");
    return this.write<void>("POST", "/messages/batchModify", {
      ids: ids.map(validateId),
      addLabelIds: addLabelIds.length ? addLabelIds : undefined,
      removeLabelIds: removeLabelIds.length ? removeLabelIds : undefined,
    });
  }

  /** messages.trash / untrash, threads.trash / untrash (gmail.modify). Reversibili per 30 giorni. */
  trash(kind: "message" | "thread", id: string) {
    return this.write<unknown>("POST", `/${kind === "message" ? "messages" : "threads"}/${validateId(id)}/trash`);
  }

  untrash(kind: "message" | "thread", id: string) {
    return this.write<unknown>("POST", `/${kind === "message" ? "messages" : "threads"}/${validateId(id)}/untrash`);
  }

  /** drafts.list (gmail.readonly). */
  listDrafts(opts: { maxResults: number; pageToken?: string }) {
    return this.get<{ drafts?: GmailDraft[]; nextPageToken?: string; resultSizeEstimate?: number }>("/drafts", {
      maxResults: opts.maxResults,
      pageToken: opts.pageToken,
    });
  }

  /** drafts.get (gmail.readonly o gmail.compose). */
  getDraft(id: string, format: "full" | "metadata" = "full") {
    return this.get<GmailDraft>(`/drafts/${validateId(id)}`, { format });
  }

  /** drafts.get format=raw: messaggio completo della bozza in base64url (per verificarne l'integrita'). */
  getDraftRaw(id: string) {
    return this.get<GmailDraft & { message?: GmailMessage & { raw?: string } }>(`/drafts/${validateId(id)}`, { format: "raw" });
  }

  /**
   * drafts.send (gmail.compose o gmail.modify): INVIA la bozza. Operazione irreversibile e non idempotente:
   * da chiamare solo da executeSendDraft (src/gmail/send.ts), dopo conferma e verifica di integrita'.
   */
  sendDraft(id: string) {
    return this.write<GmailMessage>("POST", "/drafts/send", { id: validateId(id) });
  }

  /** drafts.create (gmail.compose): `raw` = messaggio RFC 5322 in base64url. NON invia. */
  createDraft(raw: string, threadId?: string) {
    return this.write<GmailDraft>("POST", "/drafts", {
      message: { raw, threadId: threadId ? validateId(threadId) : undefined },
    });
  }

  /** drafts.update (gmail.compose): sostituisce il contenuto della bozza. NON invia. */
  updateDraft(id: string, raw: string, threadId?: string) {
    return this.write<GmailDraft>("PUT", `/drafts/${validateId(id)}`, {
      id,
      message: { raw, threadId: threadId ? validateId(threadId) : undefined },
    });
  }

  /** labels.create (gmail.labels o gmail.modify): nuova etichetta, visibile nell'elenco e nei messaggi. */
  createLabel(name: string) {
    return this.write<GmailLabel>("POST", "/labels", {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    });
  }

  /** labels.list (gmail.readonly), memorizzato per la durata della singola chiamata al tool. */
  listLabels(): Promise<GmailLabel[]> {
    this.labelsCache ??= this.get<{ labels?: GmailLabel[] }>("/labels").then((r) => r.labels ?? []);
    return this.labelsCache;
  }
}
