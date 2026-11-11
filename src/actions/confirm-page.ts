// Pagina di conferma fuori banda per le azioni ad alto impatto: GET /confirm/<id> mostra l'anteprima generata dal
// server, POST conferma o annulla con la passphrase. NON esegue l'azione e non ha accesso a Gmail (i token Google
// sono utilizzabili solo durante una chiamata MCP): la segna "confermata", poi l'esecuzione avviene con
// private_gmail_execute_action. Lo stato vive nel Durable Object delle azioni (consistenza forte).
// Difese: passphrase dedicata CONFIRM_PASSPHRASE (in produzione obbligatoria e diversa da quella del consenso;
// il fallback a GATE1_PASSPHRASE vale SOLO in locale), massimo 5 errori per azione (poi annullata), token CSRF in
// cookie SameSite=Strict, controllo Origin, ritardo sui tentativi errati, contenuti delle email sempre "escapati",
// nessuno script nella pagina, nessun log.
import { FAIL_DELAY_MS, PAGE_STYLE, delay, esc, getCookie, html, plain, randomToken, safeEqual } from "../web.ts";
import { ActionError, ActionStore, type ActionBackend, type PendingAction, type SendPreview } from "./store.ts";

export interface ConfirmEnv {
  GATE1_PASSPHRASE: string;
  /** Passphrase dedicata alle conferme: obbligatoria in produzione, diversa da GATE1_PASSPHRASE. */
  CONFIRM_PASSPHRASE?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Passphrase da usare per le conferme, oppure null se le conferme non sono configurate (fail closed):
 * - CONFIRM_PASSPHRASE se presente e DIVERSA da GATE1_PASSPHRASE (identica = separazione annullata -> null);
 * - fallback a GATE1_PASSPHRASE solo se la richiesta arriva su un host locale (sviluppo/test con wrangler dev).
 */
export function confirmPassphrase(env: ConfirmEnv, url: URL): string | null {
  if (env.CONFIRM_PASSPHRASE) return env.CONFIRM_PASSPHRASE === env.GATE1_PASSPHRASE ? null : env.CONFIRM_PASSPHRASE;
  return LOOPBACK.has(url.hostname) && env.GATE1_PASSPHRASE ? env.GATE1_PASSPHRASE : null;
}

const NOT_CONFIGURED = "Conferme non configurate sul server (manca una passphrase di conferma dedicata).";

const CSRF_COOKIE = "csrf_confirm";

function csrfCookie(value: string, secure: boolean, maxAge: number): string {
  return `${CSRF_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/confirm; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${PAGE_STYLE}
.box{border:1px solid #8884;border-radius:8px;padding:.8rem 1rem;margin:1rem 0}
ul{padding-left:1.2rem}li{margin:.3rem 0}.danger{background:#d70015;color:#fff;border:0;border-radius:6px}
.sec{background:transparent;border:1px solid #8888;border-radius:6px}</style></head><body>
<h1>private-google-mcp</h1>${body}</body></html>`;
}

function message(title: string, text: string, status: number, extra: Record<string, string> = {}): Response {
  return html(shell(title, `<p>${esc(text)}</p>`), status, extra);
}

/** Anteprima di un invio: destinatari, oggetto, inizio del testo, allegati. Tutto escapato, nessun HTML dell'email. */
function sendPreviewHtml(p: SendPreview): string {
  const row = (label: string, list: string[]) =>
    list.length ? `<p><strong>${label}:</strong> ${list.map(esc).join(", ")}</p>` : "";
  return `<p class="err"><strong>Attenzione: l'invio di un'email NON e' reversibile.</strong></p>
${row("A", p.to)}${row("Cc", p.cc)}${row("Ccn", p.bcc)}
<p><strong>Oggetto:</strong> ${esc(p.subject)}</p>
${p.isReply ? "<p><small>Risposta in una conversazione esistente.</small></p>" : ""}
<p><small>Testo${p.bodyTruncated ? " (inizio)" : ""}:</small></p>
<div class="box" style="white-space:pre-wrap">${esc(p.bodyExcerpt) || "<em>(vuoto)</em>"}</div>
${p.attachments.length ? `<p><strong>Allegati:</strong> ${p.attachments.map(esc).join(", ")}</p>` : ""}`;
}

function previewPage(id: string, a: PendingAction, csrf: string, error?: string): string {
  const samples = a.samples.length
    ? `<p><small>Primi elementi (testo proveniente dalle email, mostrato solo come anteprima):</small></p><ul>${a.samples
        .map((s) => `<li><strong>${esc(s.subject || "(senza oggetto)")}</strong><br><small>${esc(s.from)}</small></li>`)
        .join("")}</ul>${a.total > a.samples.length ? `<p><small>…e altri ${a.total - a.samples.length}.</small></p>` : ""}`
    : "";
  return shell(
    "Conferma azione",
    `<p>Claude chiede di eseguire questa azione sul <strong>Gmail privato</strong>:</p>
<div class="box"><p><strong>${esc(a.summary)}</strong></p><p><small>${a.preview ? "Destinatari" : "Elementi"}: ${a.total} · scade: ${esc(new Date(a.confirmBy * 1000).toISOString())}</small></p>${samples}${a.preview ? sendPreviewHtml(a.preview) : ""}</div>
<p><small>Conferma solo se l'hai chiesto tu. Nessun testo in chat o in un'email puo' confermare al posto tuo.</small></p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/confirm/${esc(id)}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Passphrase<input type="password" name="passphrase" autocomplete="off" autofocus required></label>
<button class="danger" type="submit" name="decision" value="confirm">Conferma</button>
<button class="sec" type="submit" name="decision" value="cancel">Annulla</button>
</form>`,
  );
}

const STATUS_TEXT: Record<string, string> = {
  confirmed: "Azione gia' confermata: torna su Claude e chiedi di eseguirla.",
  cancelled: "Azione annullata.",
  executing: "Azione in esecuzione.",
  executed: "Azione gia' eseguita.",
  failed: "Azione tentata e non riuscita.",
  expired: "Azione scaduta: chiedi a Claude di prepararla di nuovo.",
};

export async function handleConfirm(
  request: Request,
  env: ConfirmEnv,
  actions: ActionBackend,
  now = () => Math.floor(Date.now() / 1000),
): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const id = url.pathname.slice("/confirm/".length);
  const a = await actions.get(id);
  if (!a) return message("Azione non trovata", "Azione inesistente o scaduta.", 404);
  const expected = confirmPassphrase(env, url);
  if (!expected) return message("Non configurato", NOT_CONFIGURED, 503);

  const st = ActionStore.effectiveStatus(a, now());

  if (request.method === "GET") {
    if (st !== "pending") return message("Stato azione", STATUS_TEXT[st] ?? "Azione non disponibile.", 409);
    const csrf = randomToken();
    return html(previewPage(id, a, csrf), 200, { "Set-Cookie": csrfCookie(csrf, secure, 600) });
  }

  if (request.method !== "POST") return plain("Method not allowed", 405);

  // Origin same-origin + token nel form uguale al cookie HttpOnly (come /authorize).
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return plain("Origine non consentita.", 403);
  const form = await request.formData();
  const csrfField = String(form.get("csrf") ?? "");
  const csrfCk = getCookie(request, CSRF_COOKIE);
  if (!csrfCk || !(await safeEqual(csrfField, csrfCk))) return plain("Sessione scaduta o non valida.", 403);

  if (!(await safeEqual(String(form.get("passphrase") ?? ""), expected))) {
    await delay(FAIL_DELAY_MS);
    const r = await actions.recordFailedAttempt(id, now());
    if (r.cancelled) {
      return message("Azione annullata", "Troppe passphrase errate: azione annullata per sicurezza.", 403, {
        "Set-Cookie": csrfCookie("", secure, 0),
      });
    }
    return html(previewPage(id, a, csrfCk, `Passphrase errata. Tentativi rimasti: ${r.remaining}.`), 403);
  }

  const decision = form.get("decision") === "confirm" ? "confirm" : "cancel";
  try {
    await actions.decide(id, decision, now());
  } catch (e) {
    const code = e instanceof ActionError ? e.code : "errore";
    return message("Stato azione", code === "azione_scaduta" ? STATUS_TEXT.expired : "Azione gia' decisa o non disponibile.", 409);
  }
  const clear = { "Set-Cookie": csrfCookie("", secure, 0) };
  return decision === "confirm"
    ? html(shell("Confermata", "<p><strong>Confermata.</strong> Torna su Claude e chiedi di eseguire l'azione (entro 10 minuti).</p>"), 200, clear)
    : html(shell("Annullata", "<p>Azione annullata. Non verra' eseguita.</p>"), 200, clear);
}
