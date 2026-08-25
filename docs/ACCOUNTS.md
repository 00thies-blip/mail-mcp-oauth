# Configuring accounts.json

The whole file is stored as a single-line JSON string in the `ACCOUNTS_JSON`
environment variable on Render (there's no persistent disk to hold a real
file). Build it locally, validate it, then paste it into Render's
Environment tab — never commit it.

`ACCOUNTS_JSON` covers **IMAP reading and IMAP APPEND**
(list/search/get/mark/move/delete, plus `create_draft` and the Sent-folder
copy) for every account. Actually **sending** goes through Brevo or the
Gmail API instead of direct SMTP — see
[Sending](#sending-brevo-or-gmail-api-instead-of-direct-smtp) below —
because Render's free tier blocks outbound SMTP ports entirely.

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
      "mail": { "defaultFrom": "00thies@gmail.com", "draftsFolder": "[Gmail]/Entwürfe", "sentFolder": "[Gmail]/Gesendet" },
      "google": { "clientId": "...apps.googleusercontent.com", "clientSecret": "GOCSPX-...", "refreshToken": "1//..." }
    },
    {
      "id": "crazycaracal",
      "label": "crazycaracal.com",
      "imap": { "host": "imap.gmail.com", "port": 993, "user": "lukas@crazycaracal.com", "pass": "", "tls": true },
      "smtp": { "host": "smtp.gmail.com", "port": 465, "user": "lukas@crazycaracal.com", "pass": "", "tls": true },
      "mail": { "defaultFrom": "lukas@crazycaracal.com", "draftsFolder": "[Gmail]/Entwürfe", "sentFolder": "[Gmail]/Gesendet" },
      "google": { "clientId": "...apps.googleusercontent.com", "clientSecret": "GOCSPX-...", "refreshToken": "1//..." }
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
- `google` (optional) — Google OAuth2 grant for this mailbox. When present, `send_message` always uses the Gmail API instead of Brevo/SMTP (needed for any google.com/Workspace address — see [Google OAuth2 setup](#google-oauth2-setup-gmail--workspace) below). If `imap.pass` is also `""` (empty string, not omitted), IMAP authenticates via XOAUTH2 with the same grant instead of a password — required for Workspace accounts where app passwords are disabled; leave `imap.pass` as a real app password (like Gmail personal above) if IMAP already works fine without OAuth and you only need OAuth for sending.

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

### crazycaracal.com (Google Workspace) — done

Uses the same Google OAuth2 client as Gmail (see below): XOAUTH2 for IMAP
(app passwords are disabled by the Workspace admin, no password path
exists at all) and the Gmail API for sending. Working in production.

### lukasthies@hotmail.com — blocked on Microsoft's side, deferred

Microsoft killed Basic Auth for consumer Outlook.com/Hotmail IMAP/SMTP
entirely (2024/25), app passwords included — this needs an Entra (Azure
AD) app registration + OAuth2/XOAUTH2, same shape as the Google work
below. Registering that app hit a wall that isn't ours to fix:

- The Entra/Azure portal threw a persistent `AADSTS50058` /
  "interaction_required" loop on the App registrations page for
  `lukasthies@hotmail.com`'s personal tenant, immediately re-appearing
  after dismissing it — reproduced across Chrome and Safari, with
  third-party cookies fully allowed, ruling out the usual browser-cookie
  explanation.
- Switched to the Azure CLI (`pip install --user azure-cli`, device-code
  login) to route around the broken web UI. Login succeeded, but
  `az ad app create` / any Microsoft Graph call (`/v1.0/me`,
  `/v1.0/organization`) failed with `"User was not found."` — a Graph-side
  error, not a CLI bug.
- Created a brand-new, completely unrelated Microsoft account
  specifically to own the app registration instead (the app owner and the
  target mailbox don't need to be the same account — only the later OAuth
  *consent* step needs to be done as `lukasthies@hotmail.com`). The new
  account's ID token resolved to the **same** tenant ID as the original
  account, and would hit the same Graph error.
- Retried on a different device on cellular data (no shared network/browser
  state at all with the machine used for everything else). Identical
  failure.

That rules out browser, cookies, device, network, and account as the
cause — this is a Microsoft-side tenant/Graph provisioning issue outside
what's fixable from here. Next step, if picked back up, is Microsoft
support rather than more client-side troubleshooting. The other four
accounts (Gmail, crazycaracal, expatandalucia, kontakt) are unaffected
and fully working.

## Sending: Brevo or Gmail API instead of direct SMTP

Render's **free tier blocks all outbound traffic to SMTP ports (25, 465,
587)** — confirmed against Gmail and two different Netcup mailboxes alike,
so it's not provider-specific. IMAP (993) is unaffected. Paid Render
instances don't have this restriction; free ones do, permanently, by
platform policy (not something DNS/network fixes can work around).

`send_message` picks a path per account, in this order:

1. **Gmail API** — if the account has a `google` block (see below). The
   only correct option for any gmail.com/Workspace address, since neither
   Brevo nor any third party can authenticate a domain they don't own.
2. **Brevo** — if `BREVO_API_KEY` is set and there's no `google` block.
   Works for any domain you can add DNS records to (see domain
   authentication below).
3. **Direct SMTP** — fallback when neither is configured, e.g. a VPS
   deployment where raw SMTP egress actually works.

### Google OAuth2 setup (Gmail + Workspace)

One Google Cloud OAuth client covers every Google-hosted mailbox (Gmail
personal, any number of Workspace addresses) — you only do steps 1-4 once.

1. [console.cloud.google.com](https://console.cloud.google.com) → new
   project → **APIs & Services → Library** → enable **Gmail API**.
2. **APIs & Services → OAuth consent screen** → External → add every
   mailbox address you'll authorize under **Test users** (required while
   the app is unverified/in testing — consent fails with a 403 otherwise).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type **Desktop app** → download the JSON, or just copy
   the `client_id` / `client_secret` shown.
4. Run a small local script once per mailbox to get a `refresh_token`: it
   starts a temporary `http://localhost:<port>` listener, prints a Google
   consent URL (scopes `https://mail.google.com/` for XOAUTH2 IMAP +
   `https://www.googleapis.com/auth/gmail.send` for the API, plus
   `openid email` so it can confirm which address you authorized),
   captures the redirect's `code`, and exchanges it for tokens via
   `POST https://oauth2.googleapis.com/token`. Use
   `access_type=offline&prompt=consent` so Google actually issues a
   `refresh_token` (it's silently omitted on a second consent for the same
   app+account unless you force it, or you revoke prior access first at
   <https://myaccount.google.com/permissions>).
5. Put the resulting `{clientId, clientSecret, refreshToken}` in that
   account's `google` block. Repeat step 4 per mailbox — same client_id/
   secret, different refresh_token each time.

For a Workspace account with app passwords disabled by admin policy
(no password-based path exists at all), also set `imap.pass` to `""` so
IMAP uses XOAUTH2 with the same grant.

### Brevo domain authentication (non-Google domains)

**Without domain authentication, Brevo silently rewrites the visible
sender to `you@NNNNNNN.brevosend.com`** — this is Brevo's mandatory
Gmail/Yahoo Feb-2024 sender-compliance behavior, not a bug and not
something a setting turns off. To send as the real address:

1. Brevo → **Senders, Domains & Dedicated IPs** → add each sender address individually (confirmation email, no DNS needed) — required regardless.
2. Then **authenticate the domain**: Brevo → Domains → Authenticate → add only the **"Authentifizierungs-Einträge"** block (Brevo-Code TXT, 2× DKIM CNAME, DMARC TXT — 4 records). Skip the **"Branding-Einträge"** block (3 more records for branded tracking links) — not required for sender authentication, and the "Marken-Eintrag" CNAME will conflict with an existing `mail` A record if your domain already has one for actual mail routing. If Brevo's UI won't let you finish without the branding block, go back a step and look for an option to skip/decline the custom tracking subdomain instead of adding those records.
3. Only works for domains you actually control DNS for. **Gmail/Workspace addresses can never be domain-authenticated this way** (you don't own google.com's DNS) — use the Gmail API path above for those instead; Brevo is only for non-Google domains.

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
