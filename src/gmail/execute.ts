// Esecuzione di un'azione CONFERMATA (tool private_gmail_execute_action): organizzazione di massa, cestino, invio.
// Il Durable Object garantisce che ogni azione passi da "confirmed" a "executing" una sola volta; qui non ci sono
// ritentativi automatici. Una scrittura riuscita su Gmail resta un successo anche se la registrazione fallisce.
import type { ActionBackend } from "../actions/store.ts";
import type { GmailClient } from "./client.ts";
import { TrashError, executeOrganize, executeTrash, type OrganizePayload, type TrashPayload } from "./organize.ts";
import { GmailInputError } from "./query.ts";
import { executeSendDraft, type SendDraftPayload } from "./send.ts";

/** Esecuzione di un'azione CONFERMATA (dal tool private_gmail_execute_action). */
export async function executeAction(
  client: GmailClient,
  store: ActionBackend,
  ctx: { googleSub: string; now: () => number },
  actionId: string,
) {
  const a = await store.beginExecution(actionId, ctx.googleSub, ctx.now());
  let result: Record<string, unknown>;
  try {
    if (a.kind === "organize") result = await executeOrganize(client, a.payload as OrganizePayload);
    else if (a.kind === "trash") result = await executeTrash(client, a.payload as TrashPayload);
    else if (a.kind === "send_draft") result = await executeSendDraft(client, a.payload as SendDraftPayload);
    else throw new GmailInputError("azione_sconosciuta");
  } catch (e) {
    const detail = e instanceof TrashError ? e.detail : {};
    const code = (e as { code?: string }).code ?? "errore_interno";
    try {
      await store.finish(actionId, false, { error: code, ...detail }, ctx.now());
    } catch {
      // Registrazione non riuscita: l'azione resta "in esecuzione" (non ripetibile). Conta l'errore originale.
    }
    throw e;
  }
  // Gmail ha eseguito: l'esito e' un successo anche se la registrazione dello stato fallisce.
  try {
    await store.finish(actionId, true, result, ctx.now());
    return { executed: true, summary: a.summary, result };
  } catch {
    return {
      executed: true,
      summary: a.summary,
      result,
      warning: "Azione eseguita, ma il suo stato non e' stato registrato: non ripeterla.",
    };
  }
}
