# Configuring accounts.json

The whole file is stored as a single-line JSON string in the `ACCOUNTS_JSON`
environment variable on Render (there's no persistent disk to hold a real
file). Build it locally, validate it, then paste it into Render's
Environment tab — never commit it.

`ACCOUNTS_JSON` only ever covers **IMAP/SMTP reading and IMAP APPEND**
(list/search/get/mark/move/delete, plus `create_draft` and the Sent-folder
copy). Actually **sending** goes through Brevo instead — see
[Sending: Brevo instead of direct SMTP](#sending-brevo-instead-of-direct-smtp)
below — because Render's free tier blocks outbound SMTP ports entirely.

## Schema

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "gmail",
      "label": "Gmail (00thies)",
      "default": true,
      "imap": { "host": "imap.gmail.com", "port": 993, "user": "00thies@gmail.com", "pass": "APP_PASSWORD", "tls": true },
      "smtp": { "host": "smtp.gmail.com", "port": 465, "user": "00thies@gmail.com", "pass": "APP_PASSWORD", "tls": true },
      "mail": { "defaultFrom": "00thies@gmail.com", "draftsFolder": "[Gmail]/Entwürfe", "sentFolder": "[Gmail]/Gesendet" }
    },
    {
      "id": "expatandalucia",
      "label": "expatandalucia.com",
      "imap": { "host": "mxe8b7.netcup.net", "port": 993, "user": "info@expatandalucia.com", "pass": "MAILBOX_PASSWORD", "tls": true },
      "smtp": { "host": "mxe8b7.netcup.net", "port": 465, "user": "info@expatandalucia.com", "pass": "MAILBOX_PASSWORD", "tls": true },
      "mail": { "defaultFrom": "info@expatandalucia.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    },
    {
      "id": "kontakt",
      "label": "kontakt@lukasthies.com",
      "imap": { "host": "mxe8b7.netcup.net", "port": 993, "user": "kontakt@lukasthies.com", "pass": "MAILBOX_PASSWORD", "tls": true },
      "smtp": { "host": "mxe8b7.netcup.net", "port": 465, "user": "kontakt@lukasthies.com", "pass": "MAILBOX_PASSWORD", "tls": true },
      "mail": { "defaultFrom": "kontakt@lukasthies.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    }
  ]
}
```

Notes:

- `id` — lowercase, `a-z0-9_-`, used as the `account` parameter in every MCP tool.
- Exactly one account should have `"default": true`.
- `tls: true` = implicit TLS on connect (typically port 993 IMAP / 465 SMTP). `tls: false` = STARTTLS on a plaintext-first connection (typically port 587 SMTP, sometimes 143 IMAP).
- `pass` — an **app-specific password**, never the account's login password, wherever 2FA is on.
- **Check real IMAP folder names before assuming English defaults** — Gmail in German shows `[Gmail]/Gesendet` / `[Gmail]/Entwürfe`, not `Sent Mail`/`Drafts`. Run `list_folders` once after adding an account and fix `draftsFolder`/`sentFolder` if they don't match, or `create_draft` and the Sent-copy step will fail for that account.

## Per-mailbox setup

### Gmail — `00thies@gmail.com`

1. Turn on 2-Step Verification if not already: <https://myaccount.google.com/security>
2. Generate an app password: <https://myaccount.google.com/apppasswords> (app: "Mail", device: "Other — mail-mcp")
3. IMAP must be enabled: Gmail → Settings → "Forwarding and POP/IMAP" → Enable IMAP.
4. Host/ports: `imap.gmail.com:993` / `smtp.gmail.com:465`, both `tls: true`.

### expatandalucia.com and kontakt@lukasthies.com — Netcup Webhosting

1. Log into the Netcup **CCP** (Customer Control Panel) → Webhosting → your package → E-Mail.
2. Click **"E-Mail-Client einrichten"** next to the address — this reveals the exact IMAP/SMTP hostname for your specific package (it varies, don't guess it). For this deployment both resolved to `mxe8b7.netcup.net:993`/`:465`.
3. Use the mailbox's own password (the one set for that email account, not your Netcup login/CCP password).

### crazycaracal.com (Google Workspace) and lukasthies@hotmail.com — deferred (Phase 2)

Neither works with a plain username+password/app-password `accounts.json`
entry:

- **crazycaracal.com**: Google Workspace with app passwords disabled by
  the admin policy — needs OAuth2 (same mechanism as Gmail API sending,
  see below).
- **hotmail.com**: Microsoft killed Basic Auth for consumer Outlook.com/
  Hotmail IMAP/SMTP entirely (2024/25), app passwords included — needs an
  Entra (Azure AD) app registration + OAuth2/XOAUTH2 token exchange.

Both need real OAuth2 client work added to the connector before these two
mailboxes can be added. Tracked separately — the other three accounts work
today without it.

## Sending: Brevo instead of direct SMTP

Render's **free tier blocks all outbound traffic to SMTP ports (25, 465,
587)** — confirmed against Gmail and two different Netcup mailboxes alike,
so it's not provider-specific. IMAP (993) is unaffected. Paid Render
instances don't have this restriction; free ones do, permanently, by
platform policy (not something DNS/network fixes can work around).

To keep sending working while staying on the free plan, `send_message`
routes through [Brevo](https://www.brevo.com)'s transactional email HTTPS
API (port 443, not blocked) instead of connecting to each mailbox's real
SMTP server. Set `BREVO_API_KEY` (Brevo dashboard → profile icon →
**SMTP & API** → **API Keys**) to enable this path; leave it unset to send
via direct SMTP instead (e.g. for a VPS deployment where that works).

**Without domain authentication, Brevo silently rewrites the visible
sender to `you@NNNNNNN.brevosend.com`** — this is Brevo's mandatory
Gmail/Yahoo Feb-2024 sender-compliance behavior, not a bug and not
something a setting turns off. To send as the real address:

1. Brevo → **Senders, Domains & Dedicated IPs** → add each sender address individually (confirmation email, no DNS needed) — required regardless.
2. Then **authenticate the domain**: Brevo → Domains → Authenticate → add only the **"Authentifizierungs-Einträge"** block (Brevo-Code TXT, 2× DKIM CNAME, DMARC TXT — 4 records). Skip the **"Branding-Einträge"** block (3 more records for branded tracking links) — not required for sender authentication, and the "Marken-Eintrag" CNAME will conflict with an existing `mail` A record if your domain already has one for actual mail routing. If Brevo's UI won't let you finish without the branding block, go back a step and look for an option to skip/decline the custom tracking subdomain instead of adding those records.
3. Only works for domains you actually control DNS for. **Gmail can never be domain-authenticated this way** (you don't own google.com's DNS) — Gmail sends via Brevo will always show the `brevosend.com` substitute address until Gmail sending moves to the Gmail API/OAuth2 (tracked with the Phase 2 work above).

Brevo also IP-allowlists API callers after a "learning phase": once it
starts blocking, get your Render service's outbound IP ranges (Render
dashboard → service → **Connect** dropdown → **Outbound** tab) and add
them at Brevo → profile icon → **Security** → **Authorised IPs** (CIDR
notation is supported directly).

## Validating before you paste it into Render

Minify to one line and check it's valid JSON, e.g. in any JS console:

```js
JSON.stringify(JSON.parse(`...paste the pretty JSON here...`))
```

Paste the resulting single-line string as the value of `ACCOUNTS_JSON` in
Render's Environment tab. Redeploy (or restart) after changing it — unlike
the file-based mode, env var changes require a restart to take effect.
