// Helper HTTP/HTML/crypto condivisi dalle pagine del Worker (/authorize, /callback, /confirm). Nessun log.

export const enc = new TextEncoder();

export const FAIL_DELAY_MS = 1500; // rallenta i tentativi sbagliati

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 32 byte casuali in esadecimale: identificatori e token non prevedibili. */
export function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Confronto a tempo costante: si confrontano gli hash SHA-256 (stessa lunghezza).
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function getCookie(request: Request, name: string): string {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  // "same-origin" e non "no-referrer": con no-referrer il browser invia `Origin: null` nel POST del form
  // e il controllo Origin lo rifiuterebbe. Verso altri siti (es. redirect al client) nessun Referer.
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

export function plain(text: string, status: number): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
}

export function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stile comune delle pagine del Worker (testo semplice, nessuno script). */
export const PAGE_STYLE = `body{font:16px -apple-system,system-ui,sans-serif;max-width:32rem;margin:8vh auto;padding:0 1rem;color:#1d1d1f}
@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}}
input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem}
button{cursor:pointer}.err{color:#d70015}small{opacity:.7}`;
