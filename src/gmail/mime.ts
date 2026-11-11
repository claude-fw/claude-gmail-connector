// Parsing dei messaggi restituiti dalla Gmail API (formato "full"): base64url, charset, intestazioni,
// albero MIME, corpo testuale, conversione HTML -> testo, allegati (solo metadati). Funzioni pure, senza rete.
// La Gmail API restituisce body.data gia' decodificato dal transfer-encoding (quoted-printable/base64):
// sono i byte del contenuto nel charset dichiarato dalla parte, codificati in base64url.

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface AttachmentInfo {
  partId: string;
  filename: string;
  mimeType: string;
  /** Dimensione in byte dichiarata da Gmail. */
  size: number;
  /** true se la parte e' "inline" (es. immagini nel corpo HTML). */
  inline: boolean;
}

export interface ExtractedContent {
  /** Testo delle parti text/plain non allegate, nell'ordine del messaggio. */
  text: string | null;
  /** HTML delle parti text/html non allegate. */
  html: string | null;
  attachments: AttachmentInfo[];
}

export function decodeBase64UrlBytes(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const LATIN1_ALIASES = new Set(["iso-8859-1", "latin1", "us-ascii", "ascii", "windows-1252", "cp1252"]);

/** Decodifica byte nel charset indicato; charset sconosciuto -> UTF-8 (byte non validi diventano U+FFFD). */
export function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  const cs = charset.trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    // Runtime senza quel decoder: per le varianti latin-1 la corrispondenza byte -> code point e' corretta
    // (windows-1252 differisce solo per 0x80-0x9F).
    if (LATIN1_ALIASES.has(cs)) {
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return s;
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function decodeBase64UrlText(data: string, charset = "utf-8"): string {
  return decodeBytes(decodeBase64UrlBytes(data), charset);
}

/** Valore della prima intestazione con quel nome (case-insensitive), "" se assente. */
export function header(headers: GmailHeader[] | undefined, name: string): string {
  const n = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
}

/** Parametro di un'intestazione strutturata, es. charset di "text/plain; charset=\"ISO-8859-1\"". */
export function headerParam(value: string, param: string): string {
  const re = new RegExp(`(?:^|;)\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i");
  const m = value.match(re);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  if (part.body?.attachmentId) return true;
  return /^\s*attachment\b/i.test(header(part.headers, "Content-Disposition"));
}

/** Scorre l'albero MIME: corpo testuale/HTML e metadati degli allegati (nessun download). */
export function extractContent(payload: GmailPart | undefined): ExtractedContent {
  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: AttachmentInfo[] = [];

  const walk = (part: GmailPart) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    if (part.parts?.length) {
      for (const p of part.parts) walk(p);
      return;
    }
    if (isAttachment(part)) {
      attachments.push({
        partId: part.partId ?? "",
        filename: part.filename || "(senza nome)",
        mimeType: mime || "application/octet-stream",
        size: part.body?.size ?? 0,
        inline: /^\s*inline\b/i.test(header(part.headers, "Content-Disposition")),
      });
      return;
    }
    const data = part.body?.data;
    if (!data) return;
    const charset = headerParam(header(part.headers, "Content-Type"), "charset") || "utf-8";
    if (mime === "text/plain") texts.push(decodeBase64UrlText(data, charset));
    else if (mime === "text/html") htmls.push(decodeBase64UrlText(data, charset));
  };
  if (payload) walk(payload);

  return {
    text: texts.length ? texts.join("\n\n") : null,
    html: htmls.length ? htmls.join("\n\n") : null,
    attachments,
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  euro: "€", bull: "•", middot: "·", deg: "°",
  agrave: "à", aacute: "á", egrave: "è", eacute: "é", igrave: "ì", iacute: "í", ograve: "ò", oacute: "ó",
  ugrave: "ù", uacute: "ú", Agrave: "À", Egrave: "È", Eacute: "É", Igrave: "Ì", Ograve: "Ò", Ugrave: "Ù",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * HTML -> testo leggibile. Rimuove script/style/head/commenti, rende i blocchi come righe,
 * gli elementi di lista come "- ", i link come "testo [url]" (solo http/https/mailto).
 * Non esegue nulla e non segue link: e' solo trasformazione di stringhe.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    // Gli spazi del sorgente HTML non sono significativi: si compattano PRIMA di inserire a capo e tabulazioni.
    .replace(/\s+/g, " ")
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, h1?: string, h2?: string, h3?: string, inner = "") => {
        // Le entita' si decodificano una volta sola, alla fine: qui il valore decodificato serve solo per i confronti.
        const rawHref = (h1 ?? h2 ?? h3 ?? "").trim();
        const href = decodeEntities(rawHref);
        const text = inner.replace(/<[^>]+>/g, "").trim();
        if (!/^(https?:|mailto:)/i.test(href)) return text;
        const plainText = decodeEntities(text);
        return !text || plainText === href || plainText === href.replace(/^mailto:/i, "") ? rawHref : `${text} [${rawHref}]`;
      })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|ul|ol|table|blockquote|section|article|header|footer|h[1-6])\s*>/gi, "\n")
    .replace(/<(p|div|tr|table|blockquote|section|article|header|footer|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/[ \f\v ]+/g, " ")
    .replace(/ *\t */g, "\t")
    .replace(/\t+(?=\n|$)/g, "")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Tronca a `max` caratteri (senza spezzare coppie surrogate). */
export function truncate(text: string, max: number): { text: string; truncated: boolean; totalChars: number } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false, totalChars: chars.length };
  return { text: chars.slice(0, max).join(""), truncated: true, totalChars: chars.length };
}
