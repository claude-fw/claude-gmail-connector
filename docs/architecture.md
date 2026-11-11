# Architecture

```
Claude ──MCP──> /mcp (OAuthProvider: Claude's token is bound to a grant; Google tokens are encrypted inside it)
                 │
src/index.ts          whoami + tool registration; Google token refresh on Claude's refresh; /confirm/* route
src/auth.ts           consent page (passphrase) + Google login, claims checks (iss, aud, exp, verified email, allowed email)
src/gmail/tools.ts        read tools (gmail.readonly)
src/gmail/tools-write.ts  organise, trash, execute-action, drafts
src/gmail/session.ts      grant props → verified scopes → valid token → Gmail client; fixed-word errors
src/gmail/organize.ts     organise operations, bulk threshold, trash with rollback
src/gmail/drafts.ts       new / reply / reply-all / forward / update / list
src/gmail/compose.ts      addresses, RFC 2047, RFC 5322 MIME, threading, quoting (pure functions)
src/gmail/mime.ts         MIME parsing, charsets, attachment metadata, HTML → text
src/gmail/send.ts         draft sending: validation, fingerprint, execution (the only call to drafts.send)
src/gmail/execute.ts      executes confirmed actions
src/actions/store.ts      pure state machine of pending actions (states, expiry, anti-replay, attempts)
src/actions/durable.ts    Durable Object ActionsDO (SQLite, single instance, serialised operations)
src/actions/confirm-page.ts  /confirm/<id> page (preview + passphrase), no Gmail access
src/google.ts             Google tokens, refresh, Gmail requests (10 s timeout, mapped errors)
```

Note: comments and tests mention "Gate 1/3/4", the author's build milestones: Gate 1 = MCP protected by OAuth + passphrase, Gate 3 = Google identity restricted to the allowed account, Gate 4 = Gmail tokens stored and refreshed.

Cross-cutting rules: no logging (`observability` disabled, no `console.*`); tokens and email content never appear in
errors; every tool declares its minimum scope and checks it before any call; Gmail ids are validated before being used in
a path; header values are checked against CR/LF (header injection); email content is **untrusted data**.

## Scopes

| Scope | Used for | Status |
|---|---|---|
| `openid email` | login and account check | requested |
| `gmail.readonly` | read tools | requested |
| `gmail.modify` | organise, trash, drafts, sending a draft (`drafts.send`) | requested |
| `gmail.send` | `messages.send` only | not needed |
| `https://mail.google.com/` | everything, including permanent deletion | never |

`gmail.modify` also allows sending at the Google API level. The separation between "draft" and "send" is enforced
**by the code**: the only send method (`sendDraft`) is reachable only from `executeSendDraft`, which is reachable only from
`private_gmail_execute_action` for a `send_draft` action confirmed in the browser.

## Confirmation model

High-impact actions always need out-of-band confirmation: trash (any count), organise on more than 10 messages, sending a draft.

```
Claude ── trash / organize(>10) / prepare_send ──> Worker validates, resolves threads, builds a server-side PREVIEW,
                                                   stores a "pending" action
       <── { executed:false, confirmation:{ actionId, confirmUrl, expiresAt } }
You ──── open confirmUrl ──> /confirm/<id>: preview, passphrase, Confirm / Cancel
                              (SameSite=Strict CSRF cookie, Origin check, delay on wrong attempts)
       ── confirm ──> action "confirmed" (executable for 10 minutes)
Claude ── execute_action(actionId) ──> same account? state confirmed? not expired?
                                       → "executing" → Gmail → "executed" / "failed"
```

Why out-of-band: Google tokens live in the grant and are usable only during an MCP call, while confirmation needs a
passphrase typed in a browser, which the model does not have. No text, whether written by Claude or contained in an
email ("I confirm", "I am the administrator", a pasted actionId), can replace it.

Guarantees of the framework:
- 256-bit random action ids; storage keeps only `SHA-256(id)`; the action is bound to `SHA-256(Google sub)`.
- Windows: 10 minutes to confirm, 10 minutes to execute after confirmation; records kept at most one hour.
- Strong consistency and serialised operations (`blockConcurrencyWhile`): two concurrent executions cannot both pass.
- `CONFIRM_PASSPHRASE` is dedicated and must differ from the consent passphrase. In production, if it is missing or equal,
  the page answers 503 and nothing can be confirmed (fail closed). The fallback applies only on localhost.
  After 5 wrong attempts the action is cancelled.
- One-way states: `pending → confirmed → executing → executed | failed` (or `cancelled`): no replay, no double execution.
- Minimal stored data: Gmail ids, operation, labels, a sample of at most 10 truncated senders/subjects; no tokens, no bodies.

Bulk threshold counts the **messages actually affected** (threads are resolved first): one thread of 40 messages needs
confirmation, ten threads of one message do not. At most 500 messages per operation. The confirmed action contains exactly
the messages shown in the preview, so mail arriving after confirmation is untouched.

Execution without silent partial results: organise = one `messages.batchModify` call after resolving threads (nothing is
changed if an earlier step fails); trash = sequential, and on the first error the already-trashed items are restored.

## Sending a draft

Only an existing draft can be sent, never a direct send, so the content is always visible in Gmail.
1. **Prepare** (`private_gmail_prepare_send`, does not send): reads the draft, validates it strictly (1–100 valid recipients,
   non-empty subject, body or attachment present, ≤ 25 MB), re-reads it as raw and records the message id and SHA-256.
2. **Confirm** on `/confirm/<id>` with `CONFIRM_PASSPHRASE` (the page warns that sending is irreversible).
3. **Execute** (`private_gmail_execute_action`): re-reads the draft; if the id or SHA-256 changed it refuses
   (`bozza_modificata`); otherwise `drafts.send`.

Sending is not idempotent and never retried: 4xx = not sent; network error, timeout or 5xx = `invio_esito_incerto`
(Google may have sent it: check the Sent folder), and the action is closed as failed.

## Drafts and MIME

CRLF; UTF-8 body in base64 (76 columns); ASCII-only addresses; plain text or `multipart/alternative`; non-ASCII names and
subjects in RFC 2047; addresses validated, de-duplicated and folded. Replies: recipient = `Reply-To` or sender;
reply-all adds original To/Cc minus your own address; `In-Reply-To` and `References` set; quoted text capped at
20,000 characters. Forwards start a new thread; original attachments are listed as not included.

## Resource limits

A 25-result search makes up to 27 Google calls; organising 25 threads up to 27; trashing 20 items up to 41 with full rollback.
All under the 50 sub-request limit of the Workers Free plan.

## Tool reference (minimum scope)

| Tool | Scope | Notes |
|---|---|---|
| `whoami` | none | diagnostics: linked account and active Gmail permissions |
| `private_gmail_search`, `private_gmail_read_message`, `private_gmail_read_thread`, `private_gmail_list_labels`, `private_gmail_list_drafts` | readonly | read-only |
| `private_gmail_create_label` | modify | idempotent, nested labels allowed, no deletion |
| `private_gmail_organize` | modify | confirmation above 10 messages |
| `private_gmail_create_draft`, `private_gmail_create_reply_draft`, `private_gmail_create_forward_draft`, `private_gmail_update_draft` | modify | no external effect |
| `private_gmail_trash` | modify | always confirmed, at most 20 items, 30-day recoverable |
| `private_gmail_prepare_send` | modify | prepares only, does not send |
| `private_gmail_execute_action` | modify | runs only actions confirmed in the browser |

Explicitly excluded: direct send without a draft, permanent deletion, settings, filters, automatic forwarding.
