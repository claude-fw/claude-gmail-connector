// Durable Object che custodisce le azioni in attesa di conferma. Un'unica istanza (idFromName) con storage SQLite:
// consistenza forte tra la pagina /confirm (data center dell'utente) e il tool di esecuzione (data center delle
// richieste MCP), e operazioni serializzate con blockConcurrencyWhile (niente doppia esecuzione concorrente).
// La logica e' in ActionsCore/ActionStore (testati in Node); qui c'e' solo l'involucro del runtime.
import { DurableObject } from "cloudflare:workers";
import type { CreateActionInput } from "./store.ts";
import { ActionsCore, DurableActionBackend, type ActionsRpc, type DOStorageLike } from "./rpc.ts";

export class ActionsDO extends DurableObject {
  private core(): ActionsCore {
    return new ActionsCore(this.ctx.storage as unknown as DOStorageLike);
  }
  private serial<T>(fn: (core: ActionsCore) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(() => fn(this.core()));
  }

  create(input: CreateActionInput<unknown>, now: number) {
    return this.serial((c) => c.create(input, now));
  }
  get(id: string, now: number) {
    return this.serial((c) => c.get(id, now));
  }
  decide(id: string, decision: "confirm" | "cancel", now: number) {
    return this.serial((c) => c.decide(id, decision, now));
  }
  recordFailedAttempt(id: string, now: number) {
    return this.serial((c) => c.recordFailedAttempt(id, now));
  }
  beginExecution(id: string, googleSub: string, now: number) {
    return this.serial((c) => c.beginExecution(id, googleSub, now));
  }
  finish(id: string, ok: boolean, result: Record<string, unknown>, now: number) {
    return this.serial((c) => c.finish(id, ok, result, now));
  }
}

/** Backend delle azioni per il Worker: sempre la stessa istanza dell'oggetto. */
export function actionsBackend(ns: DurableObjectNamespace): DurableActionBackend {
  return new DurableActionBackend(ns.get(ns.idFromName("actions-v1")) as unknown as ActionsRpc);
}
