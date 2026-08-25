# Configuring accounts.json

The whole file is stored as a single-line JSON string in the `ACCOUNTS_JSON`
environment variable on Render (there's no persistent disk to hold a real
file). Build it locally, validate it, then paste it into Render's
Environment tab — never commit it.

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
      "mail": { "defaultFrom": "00thies@gmail.com", "draftsFolder": "[Gmail]/Drafts", "sentFolder": "[Gmail]/Sent Mail" }
    },
    {
      "id": "crazycaracal",
      "label": "crazycaracal.com",
      "imap": { "host": "IMAP_HOST_FROM_NETCUP_CCP", "port": 993, "user": "lukas@crazycaracal.com", "pass": "MAILBOX_PASSWORD", "tls": true },
      "smtp": { "host": "SMTP_HOST_FROM_NETCUP_CCP", "port": 465, "user": "lukas@crazycaracal.com", "pass": "MAILBOX_PASSWORD", "tls": true },
      "mail": { "defaultFrom": "lukas@crazycaracal.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    },
    {
      "id": "expatandalucia",
      "label": "expatandalucia.com",
      "imap": { "host": "IMAP_HOST_FROM_NETCUP_CCP", "port": 993, "user": "info@expatandalucia.com", "pass": "MAILBOX_PASSWORD", "tls": true },
      "smtp": { "host": "SMTP_HOST_FROM_NETCUP_CCP", "port": 465, "user": "info@expatandalucia.com", "pass": "MAILBOX_PASSWORD", "tls": true },
      "mail": { "defaultFrom": "info@expatandalucia.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    }
  ]
}
```

Notes:

- `id` — lowercase, `a-z0-9_-`, used as the `account` parameter in every MCP tool.
- Exactly one account should have `"default": true`.
- `tls: true` = implicit TLS on connect (typically port 993 IMAP / 465 SMTP). `tls: false` = STARTTLS on a plaintext-first connection (typically port 587 SMTP, sometimes 143 IMAP) — nodemailer/imapflow negotiate STARTTLS automatically when `tls` is `false` and the server advertises it.
- `pass` — an **app-specific password**, never the account's login password, wherever 2FA is on.

## Per-mailbox setup

### Gmail — `00thies@gmail.com`

1. Turn on 2-Step Verification if not already: <https://myaccount.google.com/security>
2. Generate an app password: <https://myaccount.google.com/apppasswords> (app: "Mail", device: "Other — mail-mcp")
3. IMAP must be enabled: Gmail → Settings → "Forwarding and POP/IMAP" → Enable IMAP.
4. Host/ports: `imap.gmail.com:993` / `smtp.gmail.com:465`, both `tls: true`.

### crazycaracal.com and expatandalucia.com — Netcup Webhosting

1. Log into the Netcup **CCP** (Customer Control Panel) → Webhosting → your package → E-Mail.
2. Click **"E-Mail-Client einrichten"** next to `lukas@crazycaracal.com` / `info@expatandalucia.com` — this reveals the exact IMAP/SMTP hostname and port for your specific package (it varies by hosting product, so don't guess it).
3. Use the mailbox's own password (the one set for that email account, not your Netcup login/CCP password).

### lukasthies@hotmail.com — deferred (Phase 2)

Outlook.com/Hotmail no longer accepts IMAP/SMTP with a username+password or
app password — Microsoft requires OAuth2 (XOAUTH2) even for basic mail
protocols now. This needs an Entra (Azure AD) app registration and an
OAuth2 token exchange added to the connector before this mailbox can be
added. Tracked separately — the other three accounts work today without it.

## Validating before you paste it into Render

Minify to one line and check it's valid JSON, e.g. in any JS console:

```js
JSON.stringify(JSON.parse(`...paste the pretty JSON here...`))
```

Paste the resulting single-line string as the value of `ACCOUNTS_JSON` in
Render's Environment tab. Redeploy (or restart) after changing it — unlike
the file-based mode, env var changes require a restart to take effect.
