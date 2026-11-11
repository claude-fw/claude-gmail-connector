import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** Storage di OAuth (client registrati, grant, token hashati). Nessun contenuto personale. */
  OAUTH_KV: KVNamespace;
  /** Helper iniettato da workers-oauth-provider. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Cloudflare Secret: passphrase provvisoria del Gate 1. Mai nel repository. */
  GATE1_PASSPHRASE: string;
  /**
   * URL pubblico esatto a cui si collega Claude (es. https://<worker>.<sub>.workers.dev/mcp).
   * Non e' un segreto. Con provider 1.x diventa l'"audience" (resource) di ogni token.
   * In locale: http://localhost:8787/mcp (da .dev.vars). In produzione: "vars" di wrangler.jsonc.
   */
  PUBLIC_MCP_URL: string;
  /** Gate 3: Client ID OAuth Google (progetto privato). Non e' un segreto: "vars" di wrangler.jsonc. */
  GOOGLE_CLIENT_ID: string;
  /** Gate 3: Cloudflare Secret. Mai nel repository. */
  GOOGLE_CLIENT_SECRET: string;
  /** Gate 3: unico indirizzo Google ammesso (Gmail privato). Secret, per non tenerlo nel repository. */
  GOOGLE_ALLOWED_EMAIL: string;
  /**
   * Secret: passphrase dedicata alla pagina /confirm, diversa da GATE1_PASSPHRASE. Obbligatoria in produzione
   * (senza, le conferme vengono rifiutate); in locale (localhost) se assente si usa GATE1_PASSPHRASE.
   */
  CONFIRM_PASSPHRASE?: string;
  /** Durable Object con lo stato delle azioni in attesa di conferma (src/actions/durable.ts). */
  ACTIONS: DurableObjectNamespace;
}
