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
    │     ├── ImapClient   ──▶ imapflow   ──▶ IMAP server (993/143) per account
    │     └── SmtpClient   ──▶ nodemailer ──▶ SMTP server (465/587) per account
    └── /health
```

## Local setup

```bash
npm install
cp .env.example .env
# fill in PUBLIC_URL, ACCOUNTS_JSON (see docs/ACCOUNTS.md), OAUTH_USER,
# OAUTH_PASS, and JWT_SECRET (openssl rand -hex 32)
npm run dev
```

## Deploying to Render

See [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md) for the full step-by-step
(GitHub push, Render web service, custom domain, Netcup DNS, connecting
Claude.ai).

## Accounts

See [docs/ACCOUNTS.md](docs/ACCOUNTS.md) for the `accounts.json` schema and
per-provider setup (Gmail app passwords, Netcup Webhosting IMAP/SMTP,
and why Hotmail/Outlook.com needs a separate OAuth2 flow).

## Tools exposed to Claude

| Tool | Purpose |
|------|---------|
| `list_accounts` | List configured mailboxes (id, label, default, From) — never credentials |
| `list_folders` | Enumerate IMAP mailboxes |
| `list_messages` | Newest N messages in a folder |
| `search_messages` | Server-side IMAP search |
| `get_message` | Full body + headers + attachment metadata |
| `send_message` | Send via SMTP (optionally copies to Sent) |
| `create_draft` | Build RFC-822 and APPEND to Drafts |
| `mark_read` | Toggle `\Seen` |
| `move_message` | Move between folders |
| `delete_message` | Delete (destructive — prefer move to Trash) |

## License

MIT — see [LICENSE](LICENSE). Original work by Markus Stöger
([maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp)).
