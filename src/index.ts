import OAuthProvider, { OAuthError } from "@cloudflare/workers-oauth-provider";
import { env as workerEnv } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { authHandler } from "./auth";
import type { Env } from "./env";
import { GMAIL_MODIFY, GoogleError, freshTokens, gmailProfile, hasGmailRead, hasScope, onTokenExchange, type GoogleTokens } from "./google.ts";
import { registerGmailReadTools } from "./gmail/tools.ts";
import { registerGmailWriteTools } from "./gmail/tools-write.ts";
import { handleConfirm } from "./actions/confirm-page.ts";
import { actionsBackend } from "./actions/durable.ts";
import type { GmailProps } from "./gmail/session.ts";
import { REFRESH_TOKEN_IDLE_TTL_S, SERVER_INSTRUCTIONS, SERVER_VERSION } from "./instructions.ts";

// Classe del Durable Object delle azioni: deve essere esportata dal modulo principale.
export { ActionsDO } from "./actions/durable.ts";

// Tool: `whoami` (diagnostico) + tool Gmail privati di lettura (src/gmail/tools.ts) e di organizzazione/bozze
// (src/gmail/tools-write.ts, attivi solo con gli scope adeguati). L'invio di una bozza avviene SOLO tramite
// private_gmail_execute_action dopo la conferma nel browser (src/gmail/send.ts). Mai token nei risultati.

function createServer() {
  const server = new McpServer({ name: "private-google-mcp", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "whoami",
    {
      title: "Stato sessione (diagnostico)",
      description:
        "Diagnostico di sola lettura del Gmail PRIVATO: conferma che la sessione MCP funziona, quale account Google e' " +
        "collegato e quali permessi Gmail sono attivi (gmailRead = lettura, gmailModify = organizzazione, bozze e " +
        "invio con conferma), verificandolo sul profilo Gmail (indirizzo e numero di messaggi). Non legge messaggi " +
        "e non modifica nulla.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_args, context) => {
      const auth = getMcpAuthContext();
      const props = (auth?.props ?? {}) as { gate?: number; googleEmail?: string; google?: GoogleTokens };
      const googleConnected = (props.gate ?? 0) >= 3 && typeof props.googleEmail === "string";
      const gmail = props.google ? await gmailStatus(props.google, props.googleEmail ?? "") : null;
      const info = {
        service: "private-google-mcp",
        gate: props.gate ?? null,
        account: "PRIVATO",
        authenticated: true,
        authMethod: googleConnected ? "passphrase + Google" : "gate1-passphrase (provvisoria)",
        googleConnected,
        googleEmail: googleConnected ? props.googleEmail : null,
        gmailRead: props.google ? hasGmailRead(props.google.scope) : false,
        gmailModify: props.google ? hasScope(props.google.scope, GMAIL_MODIFY) : false,
        gmail,
        clientId: context.http?.authInfo?.clientId ?? null,
        scopes: context.http?.authInfo?.scopes ?? [],
        grantUser: (auth?.props?.userId as string | undefined) ?? null,
        serverTime: new Date().toISOString(),
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    },
  );

  const props = () => getMcpAuthContext()?.props as GmailProps | undefined;
  const env = () => workerEnv as unknown as Env;
  registerGmailReadTools(server, { props, env });
  registerGmailWriteTools(server, {
    props,
    env,
    actions: () => actionsBackend(env().ACTIONS),
    confirmBase: () => new URL(env().PUBLIC_MCP_URL).origin,
  });

  return server;
}

// Verifica Gate 4: token Google valido (rinnovato in memoria se scaduto) + profilo Gmail. Solo parole fisse negli errori.
async function gmailStatus(tokens: GoogleTokens, googleEmail: string) {
  const env = workerEnv as unknown as Env;
  const now = Math.floor(Date.now() / 1000);
  try {
    const fresh = await freshTokens(tokens, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, now);
    const profile = await gmailProfile(fresh.accessToken);
    return {
      profileOk: true,
      sameAccount: profile.emailAddress.toLowerCase() === googleEmail.toLowerCase(),
      messagesTotal: profile.messagesTotal,
      threadsTotal: profile.threadsTotal,
      tokenRefreshedNow: fresh !== tokens,
      tokenExpiresAt: new Date(fresh.expiresAt * 1000).toISOString(),
    };
  } catch (e) {
    const code = e instanceof GoogleError ? e.code : "errore";
    return {
      profileOk: false,
      error: code,
      hint: code === "invalid_grant" ? "Autorizzazione Google scaduta o revocata: ricollega il connettore." : null,
    };
  }
}

// Handler stateless dell'API MCP (/mcp). OAuthProvider lo chiama solo con un access token valido.
// `satisfies` (non annotazione): mantiene `fetch` obbligatorio nel tipo inferito, come richiede apiHandler.
const mcpApi = {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Provider 1.x: ogni token e' legato a UNA risorsa canonica (= l'URL a cui si collega Claude).
// `resourceMetadata.resource` e' obbligatorio e deve combaciare con `apiRoute`.
// L'URL reale (workers.dev) si conosce solo dopo il deploy, quindi arriva da una variabile non segreta.
function resourceUrl(): string {
  const raw = (workerEnv as unknown as Partial<Env>).PUBLIC_MCP_URL;
  if (!raw || raw.includes("REPLACE_BEFORE_DEPLOY")) {
    throw new Error("PUBLIC_MCP_URL non configurata (vedi README).");
  }
  const u = new URL(raw); // lancia se non e' un URL valido
  if (u.pathname !== "/mcp") throw new Error("PUBLIC_MCP_URL deve terminare con /mcp.");
  return u.toString();
}

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApi,
  defaultHandler: {
    // /confirm/<id>: conferma fuori banda delle azioni ad alto impatto; tutto il resto: consenso OAuth.
    fetch(request, env, ctx) {
      if (new URL(request.url).pathname.startsWith("/confirm/")) return handleConfirm(request, env, actionsBackend(env.ACTIONS));
      return authHandler.fetch!(request, env, ctx);
    },
  } satisfies ExportedHandler<Env>,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  resourceMetadata: { resource: resourceUrl() },
  // Durata del grant legata all'uso: ogni refresh OAuth di Claude (/token) sposta la scadenza a 30 giorni da quel
  // momento. Senza questa opzione il grant scade 30 giorni dopo il consenso, per quanto venga usato.
  // Una semplice chiamata a un tool non rinnova il grant: lo fa solo il refresh del token di accesso di Claude.
  refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_S,
  // Gate 4: al rinnovo del token di Claude si rinnova anche quello Google e lo si salva nel grant.
  // invalid_grant da Google (refresh revocato o scaduto, es. 7 giorni in Testing) revoca il grant: Claude chiedera'
  // di ricollegarsi. Gli errori non contengono token.
  tokenExchangeCallback: async (options) => {
    const now = Math.floor(Date.now() / 1000);
    try {
      return await onTokenExchange(
        options.grantType,
        options.props,
        options.env.GOOGLE_CLIENT_ID,
        options.env.GOOGLE_CLIENT_SECRET,
        now,
      );
    } catch (e) {
      if (e instanceof GoogleError) {
        throw new OAuthError("invalid_grant", { description: "Autorizzazione Google non piu' valida: ricollega il connettore." });
      }
      throw e;
    }
  },
});
