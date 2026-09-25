# mail-mcp on Cloudflare Workers

The production connector since 25.09.2026. It replaces the Render service at the repo root (suspended) and the Phase 0 spike in `../spike`.

- **URL:** https://mail-mcp-oauth.00thies.workers.dev. Claude.ai connector URL: `https://mail-mcp-oauth.00thies.workers.dev/mcp`
- **Cost:** 0 € (Workers Free and one KV namespace)
- **Tools:** the same 10 as before, with the same names, parameters and output: `list_accounts`, `list_folders`, `list_messages`, `search_messages`, `get_message`, `send_message`, `create_draft`, `mark_read`, `move_message`, `delete_message`

## What changed compared with Render

| Topic | Render version | Workers version |
|---|---|---|
| IMAP | imapflow on Node | Our own client on `cloudflare:sockets` (`src/imap-proto.ts`, `src/imap-conn.ts`, `src/imap.ts`). imapflow hangs under `nodejs_compat` (see the spike), while plain sockets reach Gmail and Netcup in 30 to 400 ms. |
| Sending | Brevo, because Render blocked SMTP ports | Direct SMTP over sockets (`src/smtp.ts`, 465 implicit TLS or 587 STARTTLS). Google accounts still use the Gmail API. |
| MIME | nodemailer / mailparser | Our own builder (`src/mime.ts`) and postal-mime |
| Login at `/authorize` | Username/password form | Cloudflare Access (e-mail code to 00thies@gmail.com). The Worker also checks the Access JWT. |
| Accounts | `ACCOUNTS_JSON` env var | Pasted once at `/setup` (behind Access), tested live and stored in KV with AES-GCM encryption (key derived from `JWT_SECRET`). The `ACCOUNTS_JSON` secret remains a fallback. |
| Connection | Long-lived pool | One connection per tool call. A Worker has no process to keep a connection open in. |

## Operations

- **Adding or changing mailboxes:** open `/setup`, paste the full JSON and save. The schema is in `../docs/ACCOUNTS.md`, and `smtp`/`mail` are optional. `/setup?check` tests the stored mailboxes without changing anything.
- **Revoking all connections and tokens:** set a new `JWT_SECRET` with `wrangler secret put JWT_SECRET`. After that the mailboxes have to be saved again on `/setup`, because the KV data is encrypted with this key.
- **Deploy:** Workers Builds deploys on every push to `claude/mail-mcp-cloudflare-workers-4ctyd2`, with root `/worker` and build `npm ci && npm run build` (typecheck and tests).
- **Cloudflare Access:** the application "Mail MCP – Anmeldung" covers only `/authorize` and `/setup`. `/register`, `/token` and `/mcp` must stay reachable because Claude.ai calls them server to server; `/mcp` is protected by the OAuth bearer token.

## Tests

`npm test` covers the IMAP parser (framing, literals, ENVELOPE, BODYSTRUCTURE, modified UTF-7, RFC 2047), the MIME builder round-tripped through postal-mime, and SMTP dot-stuffing.
