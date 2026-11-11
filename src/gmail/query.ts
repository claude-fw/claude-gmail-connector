// Costruzione della query di ricerca Gmail (stessa sintassi della casella) a partire da filtri strutturati.
// I filtri si combinano in AND con l'eventuale query nativa. Valori con spazi o caratteri speciali vengono
// racchiusi tra virgolette, cosi' non possono introdurre operatori aggiuntivi.

export interface SearchFilters {
  /** Query nativa Gmail, es. `from:banca newer_than:30d -label:promozioni`. */
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** Nome della label (es. "Lavoro", "Lavoro/Fatture"). */
  label?: string;
  /** Data inclusa, formato YYYY-MM-DD. */
  after?: string;
  /** Data esclusa, formato YYYY-MM-DD. */
  before?: string;
  newerThanDays?: number;
  unread?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  /** Cartella: inbox, sent, drafts, spam, trash, anywhere (tutta la posta, anche spam e cestino). */
  folder?: "inbox" | "sent" | "drafts" | "spam" | "trash" | "anywhere";
}

/** Errore di input (parola fissa), da mostrare all'utente senza dati sensibili. */
export class GmailInputError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "GmailInputError";
    this.code = code;
  }
}

/** Valore sicuro per un operatore: virgolette se contiene spazi o caratteri della sintassi Gmail. */
export function quoteValue(v: string): string {
  const clean = v.replace(/["\r\n]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) throw new GmailInputError("filtro_vuoto");
  return /[\s(){}:,]|^-/.test(clean) ? `"${clean}"` : clean;
}

/** YYYY-MM-DD (o YYYY/MM/DD) valida -> YYYY/MM/DD per Gmail. */
export function gmailDate(v: string): string {
  const m = v.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (!m) throw new GmailInputError("data_non_valida");
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    throw new GmailInputError("data_non_valida");
  }
  return `${y}/${mo}/${d}`;
}

export function buildQuery(f: SearchFilters): string {
  const parts: string[] = [];
  if (f.query?.trim()) parts.push(f.query.trim().replace(/[\r\n]+/g, " "));
  if (f.from !== undefined) parts.push(`from:${quoteValue(f.from)}`);
  if (f.to !== undefined) parts.push(`to:${quoteValue(f.to)}`);
  if (f.subject !== undefined) parts.push(`subject:${quoteValue(f.subject)}`);
  if (f.label !== undefined) parts.push(`label:${quoteValue(f.label)}`);
  if (f.after !== undefined) parts.push(`after:${gmailDate(f.after)}`);
  if (f.before !== undefined) parts.push(`before:${gmailDate(f.before)}`);
  if (f.newerThanDays !== undefined) {
    if (!Number.isInteger(f.newerThanDays) || f.newerThanDays < 1) throw new GmailInputError("giorni_non_validi");
    parts.push(`newer_than:${f.newerThanDays}d`);
  }
  if (f.unread !== undefined) parts.push(f.unread ? "is:unread" : "is:read");
  if (f.starred !== undefined) parts.push(f.starred ? "is:starred" : "-is:starred");
  if (f.hasAttachment !== undefined) parts.push(f.hasAttachment ? "has:attachment" : "-has:attachment");
  if (f.folder !== undefined) parts.push(`in:${f.folder}`);
  return parts.join(" ");
}
