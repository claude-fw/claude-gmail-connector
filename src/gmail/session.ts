// Dalla sessione MCP autenticata (props del grant) a un client Gmail pronto, con token valido e scope verificato.
// Gli errori sono parole fisse con un suggerimento per l'utente; mai token.
import { GoogleError, freshTokens, type GoogleTokens } from "../google.ts";
import { GmailClient } from "./client.ts";
import { GmailInputError } from "./query.ts";
import { ActionError } from "../actions/store.ts";
import { TrashError } from "./organize.ts";
import { SendUncertainError } from "./send.ts";
import { scopeSatisfies, type GmailScope } from "./scopes.ts";

type FetchFn = typeof fetch;

export interface GmailSessionEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

/** Identita' del grant: serve a legare le azioni in attesa all'account e a escludere se stessi nei "rispondi a tutti". */
export interface GmailIdentity {
  googleSub: string;
  googleEmail: string;
}

export type GmailSession =
  | { ok: true; client: GmailClient; identity: GmailIdentity }
  | { ok: false; error: string; hint: string };

export type GmailProps = { google?: GoogleTokens; googleSub?: string; googleEmail?: string };

const HINTS: Record<string, string> = {
  gmail_non_collegato: "Il connettore non ha l'accesso Gmail: ricollega 'Gmail privato (private-google-mcp)' su claude.ai.",
  scope_insufficiente: "Questa operazione richiede un permesso Gmail non ancora concesso al connettore.",
  invalid_grant: "Autorizzazione Google scaduta o revocata (in modalita' Testing dura 7 giorni): ricollega il connettore.",
  scope_mancante: "Il permesso Gmail e' stato revocato su Google: ricollega il connettore.",
  refresh_non_riuscito: "Rinnovo del token Google non riuscito (temporaneo): riprova tra poco.",
  gmail_non_autorizzato: "Google ha rifiutato il token: riprova; se persiste, ricollega il connettore.",
  gmail_permesso_negato: "Google ha negato l'operazione (permesso o API non abilitata).",
  gmail_non_trovato: "Messaggio, thread o risorsa non trovati (id errato o eliminato).",
  gmail_richiesta_non_valida: "Richiesta non valida per Gmail (query, token di pagina o parametri).",
  gmail_limite: "Limite di richieste Gmail raggiunto: riprova tra poco.",
  gmail_errore: "Errore temporaneo di Gmail o di rete: riprova.",
  id_non_valido: "Id non valido: usa l'id restituito dalla ricerca.",
  data_non_valida: "Data non valida: usa il formato AAAA-MM-GG.",
  giorni_non_validi: "Il numero di giorni deve essere un intero positivo.",
  filtro_vuoto: "Un filtro di ricerca e' vuoto.",
  // organizzazione e azioni confermate
  numero_elementi_non_valido: "Numero di elementi non valido (nessuno o oltre il massimo consentito).",
  troppi_messaggi: "Le conversazioni indicate contengono troppi messaggi per una sola operazione.",
  label_non_valide: "Indica da 1 a 10 label.",
  label_non_trovata: "Label inesistente: usa private_gmail_list_labels (le label non vengono create automaticamente).",
  label_non_ammesse: "Le label si indicano solo con add_labels/remove_labels.",
  nome_label_non_valido: "Nome di etichetta non valido (vuoto, troppo lungo, con caratteri di controllo o '/' agli estremi).",
  label_riservata: "Label di sistema: usa l'operazione dedicata (letto/non letto, speciale, archivio, cestino).",
  azione_non_trovata: "Azione inesistente, scaduta o di un altro account: preparala di nuovo.",
  azione_non_confermata: "Azione non ancora confermata: l'utente deve aprire il link di conferma nel browser.",
  azione_scaduta: "Tempo scaduto: prepara di nuovo l'azione.",
  azione_annullata: "L'utente ha annullato questa azione.",
  azione_in_esecuzione: "Azione gia' in esecuzione.",
  azione_gia_eseguita: "Azione gia' eseguita: non viene ripetuta.",
  azione_fallita: "Azione gia' tentata e fallita: preparala di nuovo.",
  azione_gia_decisa: "Azione gia' confermata o annullata.",
  azione_sconosciuta: "Tipo di azione non supportato.",
  cestino_parziale_annullato:
    "Lo spostamento nel cestino si e' interrotto: gli elementi gia' spostati sono stati ripristinati (vedi dettaglio).",
  // bozze
  testo_mancante: "Indica il testo (text) e/o la versione HTML (html) della bozza.",
  destinatario_mancante: "Manca il destinatario.",
  indirizzo_non_valido: "Indirizzo email non valido.",
  intestazione_non_valida: "Valore non ammesso in un'intestazione (a capo o formato non valido).",
  troppi_destinatari: "Troppi destinatari (massimo 100).",
  oggetto_troppo_lungo: "Oggetto troppo lungo.",
  testo_troppo_lungo: "Testo troppo lungo.",
  bozza_non_valida: "Bozza non leggibile.",
  // invio
  oggetto_mancante: "La bozza non ha un oggetto: aggiungilo prima di inviarla.",
  messaggio_troppo_grande: "Messaggio troppo grande per Gmail (limite 25 MB).",
  bozza_modificata: "La bozza e' cambiata dopo la preparazione o la conferma: nulla e' stato inviato. Preparala di nuovo.",
  bozza_non_trovata: "La bozza non esiste piu' (eliminata o gia' inviata): nulla e' stato inviato.",
  invio_esito_incerto:
    "Esito dell'invio INCERTO (errore di rete o di Google dopo la richiesta): controlla la cartella Inviata. " +
    "L'azione non viene ripetuta automaticamente.",
};

export function hintFor(code: string): string {
  return HINTS[code] ?? "Errore imprevisto.";
}

/** Codice d'errore sicuro da mostrare: solo errori noti; il resto diventa "errore_interno" (senza messaggio). */
export function errorCode(e: unknown): string {
  if (
    e instanceof GoogleError ||
    e instanceof GmailInputError ||
    e instanceof ActionError ||
    e instanceof TrashError ||
    e instanceof SendUncertainError
  ) {
    return e.code;
  }
  return "errore_interno";
}

export async function gmailSession(
  props: GmailProps | undefined,
  env: GmailSessionEnv,
  required: GmailScope | GmailScope[],
  now: number,
  fetchImpl: FetchFn = fetch,
): Promise<GmailSession> {
  const google = props?.google;
  if (!google || !props?.googleSub) return { ok: false, error: "gmail_non_collegato", hint: hintFor("gmail_non_collegato") };
  if (!(Array.isArray(required) ? required : [required]).every((r) => scopeSatisfies(google.scope, r))) {
    return { ok: false, error: "scope_insufficiente", hint: hintFor("scope_insufficiente") };
  }
  try {
    const fresh = await freshTokens(google, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, now, fetchImpl);
    return {
      ok: true,
      client: new GmailClient(fresh.accessToken, fetchImpl),
      identity: { googleSub: props.googleSub, googleEmail: (props.googleEmail ?? "").toLowerCase() },
    };
  } catch (e) {
    const code = errorCode(e);
    return { ok: false, error: code, hint: hintFor(code) };
  }
}

/** Forma minima di un risultato di tool MCP. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function toolJson(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function toolError(code: string, detail?: Record<string, unknown>): ToolResult {
  const body = { errore: code, suggerimento: hintFor(code), ...(detail ? { dettaglio: detail } : {}) };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}

/** Esecuzione uniforme di un tool Gmail: sessione -> operazione -> JSON; errori solo come parole fisse. */
export async function runGmailTool<T>(
  session: Promise<GmailSession>,
  op: (client: GmailClient, identity: GmailIdentity) => Promise<T>,
): Promise<ToolResult> {
  const s = await session;
  if (!s.ok) return toolError(s.error);
  try {
    return toolJson(await op(s.client, s.identity));
  } catch (e) {
    // Solo il dettaglio numerico del cestino (conteggi), mai contenuti.
    return toolError(errorCode(e), e instanceof TrashError ? e.detail : undefined);
  }
}
