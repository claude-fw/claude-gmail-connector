# claude-gmail-connector

A remote [MCP](https://modelcontextprotocol.io) server that lets **Claude** work with **one private Gmail account**:
search and read mail, organise it, prepare drafts, and send or trash messages **only after you confirm in your browser**.
It runs on [Cloudflare Workers](https://workers.cloudflare.com) (Free plan is enough) and is a personal, single-user tool.

> Built and used by its author to manage a personal inbox from Claude. It is published as a reference
> implementation and a starting point. Read the security notes before connecting your own mailbox.

## Why this design

Giving an AI assistant access to email is risky: an email can contain text that tries to give the model orders
(prompt injection). This connector is built around that threat:

- **Single account.** Login is rejected unless the verified Google account equals `GOOGLE_ALLOWED_EMAIL`.
- **Out-of-band confirmation.** Sending, trashing and bulk changes (> 10 messages) are never executed on the model's
  word. The server returns a link; you open it, review a server-generated preview and type a *separate* passphrase.
  The model never has that passphrase, so nothing written in a chat or inside an email can replace it.
- **Drafts first.** There is no "send directly" tool. Mail is sent only from a draft you can see in Gmail. The draft is
  fingerprinted (message id + SHA-256) at confirmation time and refused if it changed afterwards.
- **No deletion, no settings.** No permanent delete, no filters, no forwarding rules, no `gmail.send` or full-mail scope.
- **Email is untrusted data.** The server instructs the model to treat message content as data, never as instructions.
- **Minimal data.** No request or content logging; email bodies are never stored; pending confirmations keep a short
  preview for at most one hour; tokens are encrypted by the OAuth provider.
- **Strong consistency for confirmations.** Pending actions live in a Durable Object (single-instance, serialised),
  not in KV, so a confirmation cannot be replayed or executed twice.

Details and the full capability and scope matrices: [docs/architecture.md](docs/architecture.md).

## Tools exposed to Claude

| Area | Tools | Needs confirmation |
|---|---|---|
| Diagnostics | `whoami` | no |
| Read | `private_gmail_search`, `private_gmail_read_message`, `private_gmail_read_thread`, `private_gmail_list_labels`, `private_gmail_list_drafts` | no |
| Organise | `private_gmail_organize` (read/unread, star, archive, labels), `private_gmail_create_label` | only above 10 messages |
| Drafts | `private_gmail_create_draft`, `private_gmail_create_reply_draft`, `private_gmail_create_forward_draft`, `private_gmail_update_draft` | no |
| Trash | `private_gmail_trash` | always |
| Send | `private_gmail_prepare_send` → `private_gmail_execute_action` | always |

## Quick start

You need: a Cloudflare account, a Google Cloud project, Node.js ≥ 24.

1. `npm install`
2. Google Cloud: enable the **Gmail API**, create an OAuth client (type *Web application*) and add the redirect URI
   `https://private-google-mcp.<your-subdomain>.workers.dev/callback`. Declared scopes: `openid email`,
   `gmail.readonly`, `gmail.modify`.
3. `cp wrangler.example.jsonc wrangler.jsonc` and fill in your URL, client ID and a KV namespace
   (`npx wrangler kv namespace create OAUTH_KV`).
4. Set the secrets, each typed by you in a terminal (never paste them in a chat):
   ```
   npx wrangler secret put GATE1_PASSPHRASE      # protects the OAuth consent page
   npx wrangler secret put CONFIRM_PASSPHRASE    # protects confirmations; must differ from the one above
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put GOOGLE_ALLOWED_EMAIL  # the only account allowed to log in
   ```
5. `npm run typecheck && npm test`, then `npm run deploy`.
6. In Claude, add a custom connector with the URL `https://private-google-mcp.<your-subdomain>.workers.dev/mcp`
   and sign in. Check with the `whoami` tool.

After a deploy: `/mcp` without a token must answer `401`, and `/debug` must answer `404`.

## Development

| Command | What it does |
|---|---|
| `npm test` | unit and in-memory MCP integration tests (dummy data only) |
| `npm run typecheck` | TypeScript check |
| `npm run dev` | local Worker on `http://localhost:8787` (copy `.dev.vars.example` to `.dev.vars`) |
| `npm run smoke` | local end-to-end check of discovery, client registration, consent, passphrase and negative cases. Start the Worker first in another terminal: `npx wrangler dev --var GOOGLE_CLIENT_SECRET:dummy --var GOOGLE_ALLOWED_EMAIL:test@example.com` |

## Known limitations

- The Google OAuth app stays "unverified" unless you go through Google's review: Google shows a warning at consent.
- Google can revoke the refresh token (manual revoke, six months of inactivity, password change); reconnect the connector.
- The MCP connection expires after 30 days without a token refresh.
- Trashing whole conversations: the rollback after an error un-trashes every message in that conversation.
- The source code, comments, test names and the confirmation page are written in **Italian** (the author's language);
  documentation is in English. Translations of the code are welcome as pull requests.

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
