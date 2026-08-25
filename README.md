# mail-mcp-oauth

Self-hosted, **OAuth 2.1-enabled** IMAP/SMTP MCP server for Claude.ai —
a fork of [maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp)
with a built-in OAuth 2.1 + Dynamic Client Registration + PKCE layer, and
adapted to run as a single stateless process on Render (no VPS, no nginx,
no systemd, no persistent disk).

Multi-account: one deployment serves several mailboxes (Gmail, custom
domains, ...), each accessible via IMAP/SMTP. Every MCP tool takes an
optional `account` parameter to pick which mailbox to act on.

## What changed vs. upstream

- **OAuth 2.1 built in** ([src/oauth.ts](src/oauth.ts)): `/register` (DCR),
  `/authorize` (PKCE + single-user login form), `/token`. No separate OAuth
  shim process — upstream references one but it isn't published, so this
  fork implements it directly in the same Express app.
- **Stateless by design**: access/refresh tokens are signed JWTs (no DB);
  registered OAuth clients and in-flight auth codes are in-memory (a
  restart just makes Claude.ai silently re-register, which its MCP client
  already handles).
- **Accounts from an env var**: `ACCOUNTS_JSON` instead of a file on disk,
  since Render's filesystem is ephemeral. File-based `ACCOUNTS_FILE` still
  works for local/VPS use.
- **CalDAV/calendar tools removed** — not needed for this deployment, cuts
  the dependency surface (`tsdav`, `ical.js`).
- **Sending via HTTP APIs, not direct SMTP**: Render's free tier blocks
  all outbound traffic to SMTP ports (25/465/587) — confirmed against
  four different mailboxes across three providers, not fixable from our
  side. `send_message` picks, per account: the **Gmail API**
  ([src/gmail-client.ts](src/gmail-client.ts)) for any Google-hosted
  address (the only way to authenticate as a domain you don't control
  DNS for), else **Brevo**'s HTTP API
  ([src/brevo-client.ts](src/brevo-client.ts)) if `BREVO_API_KEY` is set,
  else direct SMTP. IMAP is unaffected regardless. See
  [docs/ACCOUNTS.md](docs/ACCOUNTS.md#sending-brevo-or-gmail-api-instead-of-direct-smtp).
- **Google OAuth2** ([src/google-oauth.ts](src/google-oauth.ts)): XOAUTH2
  for IMAP + Gmail API for sending, for Gmail personal and Google
  Workspace mailboxes (the latter needs it for IMAP too — app passwords
  disabled by admin policy, no password path exists at all).

## Architecture

```
Claude.ai (web)
    │  HTTPS + OAuth 2.1 (DCR, PKCE, JWT)
    ▼
Render (TLS terminated automatically, custom domain mcp-mail.<domain>)
    ▼
this process (single Node service)
    ├── /.well-known/oauth-authorization-server, /register, /authorize, /token   (src/oauth.ts)
    ├── /mcp  (Bearer-gated MCP Streamable HTTP transport)
    │     ├── ImapClient   ──▶ imapflow ──▶ IMAP server (993) per account, XOAUTH2 or password
    │     └── send_message ──▶ Gmail API (Google accounts) or Brevo HTTPS API (SMTP ports blocked on Render free tier)
    └── /health
```

## Local setup

```bash
npm install
cp .env.example .env
# fill in PUBLIC_URL, ACCOUNTS_JSON (see docs/ACCOUNTS.md), OAUTH_USER,
# OAUTH_PASS, JWT_SECRET (openssl rand -hex 32), and BREVO_API_KEY
# (only needed if raw SMTP egress is blocked where you're deploying)
npm run dev
```

## Deploying to Render

See [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md) for the full step-by-step
(GitHub push, Render web service, custom domain, Netcup DNS, connecting
Claude.ai).

## Accounts

See [docs/ACCOUNTS.md](docs/ACCOUNTS.md) for the `accounts.json` schema,
per-provider setup (Gmail app passwords, Netcup Webhosting IMAP/SMTP,
Google OAuth2 for Gmail + Workspace), the Brevo sender-domain-
authentication steps for non-Google domains, and why Hotmail is currently
blocked on a Microsoft-side issue rather than anything in this repo.

## Tools exposed to Claude

| Tool | Purpose |
|------|---------|
| `list_accounts` | List configured mailboxes (id, label, default, From) — never credentials |
| `list_folders` | Enumerate IMAP mailboxes |
| `list_messages` | Newest N messages in a folder |
| `search_messages` | Server-side IMAP search |
| `get_message` | Full body + headers + attachment metadata |
| `send_message` | Send (Gmail API / Brevo / SMTP depending on account, optionally copies to Sent) |
| `create_draft` | Build RFC-822 and APPEND to Drafts |
| `mark_read` | Toggle `\Seen` |
| `move_message` | Move between folders |
| `delete_message` | Delete (destructive — prefer move to Trash) |

## License

MIT — see [LICENSE](LICENSE). Original work by Markus Stöger
([maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp)).
