// Ponte tra il Worker e il Durable Object delle azioni (src/actions/durable.ts), senza dipendenze dal runtime:
// - ActionsCore: le operazioni eseguite DENTRO l'oggetto, con risposte serializzabili ({ ok, value } / { ok:false, code }),
//   perche' le classi d'errore non attraversano l'RPC;
// - DurableActionBackend: lato Worker, implementa ActionBackend chiamando lo stub e ricostruendo ActionError.
// Testabile in Node con un archivio finto (tests/gmail-actions.test.mts).
import {
  ACTION_ERROR_CODES,
  ACTION_KEY_PREFIX,
  ACTION_LIMITS,
  ActionError,
  ActionStore,
  type ActionBackend,
  type CreateActionInput,
  type KVLike,
  type PendingAction,
} from "./store.ts";

export type Envelope<T> = { ok: true; value: T } | { ok: false; code: string };

/** Archivio del Durable Object (sottoinsieme di DurableObjectStorage). */
export interface DOStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** Adattatore: lo storage del Durable Object come KVLike (le scadenze sono gestite da purgeExpired). */
export function storageAsKV(storage: DOStorageLike): KVLike {
  return {
    get: async (key) => {
      const v = await storage.get<string>(key);
      return v === undefined ? null : JSON.parse(v);
    },
    put: async (key, value) => {
      await storage.put(key, value);
    },
    delete: async (key) => {
      await storage.delete(key);
    },
  };
}

async function wrap<T>(fn: () => Promise<T>): Promise<Envelope<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, code: e.code };
    throw e;
  }
}

/** Operazioni dell'oggetto. Ogni chiamata deve essere serializzata dal chiamante (blockConcurrencyWhile). */
export class ActionsCore {
  private readonly storage: DOStorageLike;
  private readonly store: ActionStore;
  constructor(storage: DOStorageLike) {
    this.storage = storage;
    this.store = new ActionStore(storageAsKV(storage));
  }

  /** Elimina i record oltre la durata massima (eseguita a ogni creazione: pochi record per uso personale). */
  async purgeExpired(now: number): Promise<number> {
    const all = await this.storage.list<string>({ prefix: ACTION_KEY_PREFIX });
    let removed = 0;
    for (const [key, raw] of all) {
      let createdAt = 0;
      try {
        createdAt = (JSON.parse(raw) as PendingAction).createdAt;
      } catch {
        /* record illeggibile: si elimina */
      }
      if (!(createdAt + ACTION_LIMITS.recordTtlS > now)) {
        await this.storage.delete(key);
        removed++;
      }
    }
    return removed;
  }

  create(input: CreateActionInput<unknown>, now: number) {
    return wrap(async () => {
      await this.purgeExpired(now);
      return this.store.create(input, now);
    });
  }
  get(id: string, now: number) {
    return wrap(async () => {
      const a = await this.store.get(id);
      // Un record oltre la durata massima equivale a inesistente anche prima della pulizia.
      return a && a.createdAt + ACTION_LIMITS.recordTtlS > now ? a : null;
    });
  }
  decide(id: string, decision: "confirm" | "cancel", now: number) {
    return wrap(() => this.store.decide(id, decision, now));
  }
  recordFailedAttempt(id: string, now: number) {
    return wrap(() => this.store.recordFailedAttempt(id, now));
  }
  beginExecution(id: string, googleSub: string, now: number) {
    return wrap(() => this.store.beginExecution(id, googleSub, now));
  }
  finish(id: string, ok: boolean, result: Record<string, unknown>, now: number) {
    return wrap(() => this.store.finish(id, ok, result, now));
  }
}

/** Interfaccia RPC dello stub (stessi metodi di ActionsCore). */
export type ActionsRpc = {
  [K in "create" | "get" | "decide" | "recordFailedAttempt" | "beginExecution" | "finish"]: (
    ...args: Parameters<ActionsCore[K]>
  ) => Promise<Envelope<unknown>>;
};

function unwrap<T>(e: Envelope<unknown>): T {
  if (e.ok) return e.value as T;
  throw new ActionError((ACTION_ERROR_CODES as readonly string[]).includes(e.code) ? e.code : "azione_non_trovata");
}

/** ActionBackend lato Worker: ogni operazione e' una chiamata all'unica istanza del Durable Object. */
export class DurableActionBackend implements ActionBackend {
  private readonly stub: ActionsRpc;
  constructor(stub: ActionsRpc) {
    this.stub = stub;
  }
  async create<P>(input: CreateActionInput<P>, now: number) {
    return unwrap<{ id: string; action: PendingAction<P> }>(await this.stub.create(input as CreateActionInput<unknown>, now));
  }
  async get(id: string) {
    return unwrap<PendingAction | null>(await this.stub.get(id, Math.floor(Date.now() / 1000)));
  }
  async decide(id: string, decision: "confirm" | "cancel", now: number) {
    return unwrap<PendingAction>(await this.stub.decide(id, decision, now));
  }
  async recordFailedAttempt(id: string, now: number) {
    return unwrap<{ cancelled: boolean; remaining: number }>(await this.stub.recordFailedAttempt(id, now));
  }
  async beginExecution(id: string, googleSub: string, now: number) {
    return unwrap<PendingAction>(await this.stub.beginExecution(id, googleSub, now));
  }
  async finish(id: string, ok: boolean, result: Record<string, unknown>, now: number) {
    unwrap<void>(await this.stub.finish(id, ok, result, now));
  }
}
