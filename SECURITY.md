# Security policy

This project handles access to a personal mailbox, so security reports are welcome.

**Please do not open a public issue for a vulnerability.** Use GitHub's private reporting instead:
the repository's **Security** tab → **Report a vulnerability**.

Useful to include: the affected file or flow, steps to reproduce, and the impact you expect.
This is a personal project maintained in spare time: expect a reply within a few days, not hours.

## Scope and design guarantees (what a report can challenge)
- Only the single Google account set in `GOOGLE_ALLOWED_EMAIL` can log in.
- Sending an email, trashing messages and bulk changes (> 10 messages) can only be executed after the owner
  confirms them in a browser page protected by a separate passphrase. The model never sees that passphrase.
- No request, token or email content is logged. Email content is never stored; pending confirmations keep only a
  short preview and are deleted after one hour.
- The Google scopes requested are `gmail.readonly` and `gmail.modify`. Never `gmail.send` and never full mail access.

If you deploy your own copy, you are responsible for your Cloudflare and Google Cloud configuration and secrets.
