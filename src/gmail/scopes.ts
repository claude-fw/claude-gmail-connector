// Scope Gmail e loro gerarchia. Ogni tool dichiara lo scope MINIMO che gli serve; la verifica accetta anche
// gli scope piu' ampi che Google considera sufficienti per la stessa API.
// `https://mail.google.com/` (accesso totale, cancellazione definitiva) e' escluso di proposito: non va mai richiesto.
import { GMAIL_MODIFY, GMAIL_READONLY } from "../google.ts";

export const GMAIL_SCOPES = {
  readonly: GMAIL_READONLY,
  labels: "https://www.googleapis.com/auth/gmail.labels",
  compose: "https://www.googleapis.com/auth/gmail.compose",
  send: "https://www.googleapis.com/auth/gmail.send",
  modify: GMAIL_MODIFY,
} as const;

export type GmailScope = (typeof GMAIL_SCOPES)[keyof typeof GMAIL_SCOPES];

// Per ogni scope richiesto, gli scope concessi che lo soddisfano (documentazione Gmail API, "Authorization scopes"
// dei singoli metodi): es. messages.get accetta readonly o modify; messages.send accetta send, compose o modify.
const SATISFIED_BY: Record<GmailScope, readonly GmailScope[]> = {
  [GMAIL_SCOPES.readonly]: [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify],
  [GMAIL_SCOPES.labels]: [GMAIL_SCOPES.labels, GMAIL_SCOPES.modify],
  [GMAIL_SCOPES.compose]: [GMAIL_SCOPES.compose, GMAIL_SCOPES.modify],
  [GMAIL_SCOPES.send]: [GMAIL_SCOPES.send, GMAIL_SCOPES.compose, GMAIL_SCOPES.modify],
  [GMAIL_SCOPES.modify]: [GMAIL_SCOPES.modify],
};

/** true se gli scope concessi (stringa separata da spazi) bastano per `required`. */
export function scopeSatisfies(granted: string, required: GmailScope): boolean {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return SATISFIED_BY[required].some((s) => have.has(s));
}
