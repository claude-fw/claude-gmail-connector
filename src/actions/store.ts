// Azioni in attesa di conferma: PREPARA -> ANTEPRIMA -> CONFERMA (pagina /confirm, browser + passphrase) -> ESEGUI.
//
// Perche' la conferma e' fuori banda: i token Google sono nei props del grant, utilizzabili solo durante una
// chiamata MCP; il modello invece non puo' completare la pagina di conferma (serve la passphrase nel browser).
// Quindi nessun testo (ne' di Claude ne' di un'email) puo' autorizzare un'azione.
//
// Questo file contiene la macchina a stati PURA (ActionStore) su un archivio chiave/valore astratto.
// In produzione gira dentro un Durable Object (src/actions/durable.ts) che serializza ogni operazione:
// consistenza forte e niente doppia esecuzione concorrente. NON va usato direttamente su Workers KV,
// che e' eventualmente consistente (fino a 60 s tra localita' diverse) e non offre operazioni atomiche.
//
// Garanzie: id casuale a 256 bit, si salva solo il suo SHA-256 (le chiavi non rivelano id utilizzabili);
// azione legata all'hash dell'account Google; scadenze; stati a senso unico; massimo 5 passphrase errate per
// azione (poi annullata). Si salva il minimo: id Gmail, operazione, label, un campione di al massimo 10
// mittenti/oggetti troncati per l'anteprima. Nessun token, nessun corpo di email.
import { randomToken, sha256Hex } from "../web.ts";

/** Archivio chiave/valore minimo (valori JSON come stringhe). */
export interface KVLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ACTION_LIMITS = {
  /** Tempo per confermare dalla creazione. */
  confirmWindowS: 600,
  /** Tempo per eseguire dopo la conferma. */
  executeWindowS: 600,
  /** Durata del record (oltre le finestre: un'azione conclusa resta visibile e non rieseguibile). */
  recordTtlS: 3600,
  samplesMax: 10,
  sampleChars: 100,
  /** Passphrase errate ammesse sulla pagina di conferma prima dell'annullamento automatico. */
  maxPassphraseFailures: 5,
  /** Anteprima di invio: limiti dei campi conservati. */
  previewAddressesMax: 100,
  previewAddressChars: 320,
  previewSubjectChars: 300,
  previewBodyChars: 2000,
  previewAttachmentsMax: 20,
} as const;

export type ActionStatus = "pending" | "confirmed" | "cancelled" | "executing" | "executed" | "failed";

export interface ActionSample {
  from: string;
  subject: string;
}

/**
 * Anteprima di un invio (generata dal server dalla bozza, mostrata sulla pagina di conferma). Contiene dati
 * dell'email, necessari per una conferma consapevole: troncati e conservati solo per la durata del record (1 ora).
 */
export interface SendPreview {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyExcerpt: string;
  bodyTruncated: boolean;
  attachments: string[];
  isReply: boolean;
}

export interface PendingAction<P = unknown> {
  v: 1;
  kind: string;
  status: ActionStatus;
  /** SHA-256 del `sub` Google dell'account che ha preparato l'azione. */
  accountHash: string;
  createdAt: number;
  confirmBy: number;
  confirmedAt?: number;
  executeBy?: number;
  finishedAt?: number;
  /** Descrizione generata dal server (mai testo fornito dal modello o da un'email). */
  summary: string;
  total: number;
  samples: ActionSample[];
  /** Solo per gli invii: anteprima del messaggio. */
  preview?: SendPreview;
  payload: P;
  failedAttempts?: number;
  /** Motivo di un annullamento automatico (es. troppe passphrase errate). */
  cancelReason?: string;
  /** Esito sintetico (conteggi/codici), senza contenuti. */
  result?: Record<string, unknown>;
}

export interface CreateActionInput<P> {
  kind: string;
  googleSub: string;
  summary: string;
  total: number;
  samples: ActionSample[];
  preview?: SendPreview;
  payload: P;
}

/** Operazioni sullo stato delle azioni: implementate da ActionStore e, in produzione, dal Durable Object. */
export interface ActionBackend {
  create<P>(input: CreateActionInput<P>, now: number): Promise<{ id: string; action: PendingAction<P> }>;
  get(id: string): Promise<PendingAction | null>;
  decide(id: string, decision: "confirm" | "cancel", now: number): Promise<PendingAction>;
  recordFailedAttempt(id: string, now: number): Promise<{ cancelled: boolean; remaining: number }>;
  beginExecution(id: string, googleSub: string, now: number): Promise<PendingAction>;
  finish(id: string, ok: boolean, result: Record<string, unknown>, now: number): Promise<void>;
}

export class ActionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ActionError";
    this.code = code;
  }
}

/** Codici d'errore del framework (anche per ricostruire ActionError dopo una chiamata RPC). */
export const ACTION_ERROR_CODES = [
  "azione_non_trovata",
  "azione_non_confermata",
  "azione_scaduta",
  "azione_annullata",
  "azione_in_esecuzione",
  "azione_gia_eseguita",
  "azione_fallita",
  "azione_gia_decisa",
  "azione_non_in_esecuzione",
] as const;

export const ACTION_ID_RE = /^[0-9a-f]{64}$/;
export const ACTION_KEY_PREFIX = "action:";
const keyFor = async (id: string) => `${ACTION_KEY_PREFIX}${await sha256Hex(id)}`;

function clip(s: string, max: number, flatten = true): string {
  const flat = flatten ? s.replace(/[\r\n\t]+/g, " ").trim() : s;
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : flat;
}

function clipSample(s: string): string {
  return clip(s, ACTION_LIMITS.sampleChars);
}

function clipPreview(p: SendPreview): SendPreview {
  const L = ACTION_LIMITS;
  const list = (xs: string[]) => xs.slice(0, L.previewAddressesMax).map((x) => clip(x, L.previewAddressChars));
  const body = Array.from(p.bodyExcerpt);
  return {
    to: list(p.to),
    cc: list(p.cc),
    bcc: list(p.bcc),
    subject: clip(p.subject, L.previewSubjectChars),
    bodyExcerpt: body.slice(0, L.previewBodyChars).join(""),
    bodyTruncated: p.bodyTruncated || body.length > L.previewBodyChars,
    attachments: p.attachments.slice(0, L.previewAttachmentsMax).map((a) => clip(a, L.sampleChars)),
    isReply: p.isReply,
  };
}

export class ActionStore implements ActionBackend {
  private readonly kv: KVLike;
  constructor(kv: KVLike) {
    this.kv = kv;
  }

  private async save(id: string, a: PendingAction): Promise<void> {
    await this.kv.put(await keyFor(id), JSON.stringify(a), { expirationTtl: ACTION_LIMITS.recordTtlS });
  }

  async create<P>(input: CreateActionInput<P>, now: number): Promise<{ id: string; action: PendingAction<P> }> {
    const id = randomToken();
    const action: PendingAction<P> = {
      v: 1,
      kind: input.kind,
      status: "pending",
      accountHash: await sha256Hex(input.googleSub),
      createdAt: now,
      confirmBy: now + ACTION_LIMITS.confirmWindowS,
      summary: input.summary,
      total: input.total,
      samples: input.samples
        .slice(0, ACTION_LIMITS.samplesMax)
        .map((s) => ({ from: clipSample(s.from), subject: clipSample(s.subject) })),
      ...(input.preview ? { preview: clipPreview(input.preview) } : {}),
      payload: input.payload,
    };
    await this.save(id, action);
    return { id, action };
  }

  async get(id: string): Promise<PendingAction | null> {
    if (!ACTION_ID_RE.test(id)) return null;
    const a = (await this.kv.get(await keyFor(id), "json")) as PendingAction | null;
    return a && a.v === 1 ? a : null;
  }

  /** Stato effettivo, tenendo conto delle scadenze. */
  static effectiveStatus(a: PendingAction, now: number): ActionStatus | "expired" {
    if (a.status === "pending" && now > a.confirmBy) return "expired";
    if (a.status === "confirmed" && now > (a.executeBy ?? 0)) return "expired";
    return a.status;
  }

  /** Conferma o annullamento dalla pagina /confirm (dopo la verifica della passphrase). */
  async decide(id: string, decision: "confirm" | "cancel", now: number): Promise<PendingAction> {
    const a = await this.get(id);
    if (!a) throw new ActionError("azione_non_trovata");
    const st = ActionStore.effectiveStatus(a, now);
    if (st !== "pending") throw new ActionError(st === "expired" ? "azione_scaduta" : "azione_gia_decisa");
    if (decision === "confirm") {
      a.status = "confirmed";
      a.confirmedAt = now;
      a.executeBy = now + ACTION_LIMITS.executeWindowS;
    } else {
      a.status = "cancelled";
      a.finishedAt = now;
    }
    await this.save(id, a);
    return a;
  }

  /** Passphrase errata sulla pagina di conferma: dopo il massimo consentito l'azione viene annullata. */
  async recordFailedAttempt(id: string, now: number): Promise<{ cancelled: boolean; remaining: number }> {
    const a = await this.get(id);
    if (!a || ActionStore.effectiveStatus(a, now) !== "pending") return { cancelled: false, remaining: 0 };
    a.failedAttempts = (a.failedAttempts ?? 0) + 1;
    const remaining = Math.max(0, ACTION_LIMITS.maxPassphraseFailures - a.failedAttempts);
    if (remaining === 0) {
      a.status = "cancelled";
      a.cancelReason = "troppi_tentativi";
      a.finishedAt = now;
    }
    await this.save(id, a);
    return { cancelled: remaining === 0, remaining };
  }

  /**
   * Inizio esecuzione (tool MCP): solo un'azione CONFERMATA, non scaduta, dello stesso account.
   * Passa subito a "executing": una seconda chiamata trova lo stato cambiato e viene rifiutata
   * (garantito anche in concorrenza perche' il Durable Object serializza le operazioni).
   */
  async beginExecution(id: string, googleSub: string, now: number): Promise<PendingAction> {
    const a = await this.get(id);
    if (!a) throw new ActionError("azione_non_trovata");
    if (a.accountHash !== (await sha256Hex(googleSub))) throw new ActionError("azione_non_trovata");
    const st = ActionStore.effectiveStatus(a, now);
    const refusal: Record<string, string> = {
      pending: "azione_non_confermata",
      expired: "azione_scaduta",
      cancelled: "azione_annullata",
      executing: "azione_in_esecuzione",
      executed: "azione_gia_eseguita",
      failed: "azione_fallita",
    };
    if (st !== "confirmed") throw new ActionError(refusal[st]);
    a.status = "executing";
    await this.save(id, a);
    return a;
  }

  /** Esito finale: rilegge lo stato attuale (mai una copia in memoria) e accetta solo un'azione in esecuzione. */
  async finish(id: string, ok: boolean, result: Record<string, unknown>, now: number): Promise<void> {
    const a = await this.get(id);
    if (!a || a.status !== "executing") throw new ActionError("azione_non_in_esecuzione");
    a.status = ok ? "executed" : "failed";
    a.finishedAt = now;
    a.result = result;
    await this.save(id, a);
  }
}
