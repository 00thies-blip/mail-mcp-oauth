# Deploying to Render + Netcup DNS + Claude.ai

## 1. Push to GitHub

```bash
git remote add origin git@github.com:<you>/mail-mcp-oauth.git
git push -u origin main
```

(See the main chat thread for the one-time SSH key setup if you haven't
added a deploy key to your GitHub account yet.)

## 2. Create the Render web service

1. [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**
2. Connect the GitHub repo you just pushed.
3. Render should auto-detect `render.yaml` (Blueprint) — if not, set manually:
   - **Runtime**: Node
   - **Build command**: `npm ci && npm run build`
   - **Start command**: `npm start`
   - **Plan**: Free (upgrade to Starter later if the ~50s cold-start on the
     free tier is annoying for Claude.ai's first request after idle)
4. Under **Environment**, add (values from your own generation / accounts.json — see docs/ACCOUNTS.md):
   - `PUBLIC_URL` = the service's own `https://<name>.onrender.com` URL to start (switch to the custom domain once step 4 below actually verifies — Render's own verification can lag well behind DNS actually propagating, see the note there)
   - `ACCOUNTS_JSON` = the minified accounts.json string
   - `OAUTH_USER` = a username you choose
   - `OAUTH_PASS` = a strong password you choose
   - `JWT_SECRET` = output of `openssl rand -hex 32`
   - `BREVO_API_KEY` = see [docs/ACCOUNTS.md#sending-brevo-instead-of-direct-smtp](ACCOUNTS.md#sending-brevo-instead-of-direct-smtp) — without this, `send_message` will time out on Render's free tier (SMTP ports are blocked outbound), everything else (IMAP) still works fine
5. Deploy. Watch the build logs — `npm ci` needs a committed `package-lock.json`
   (generate one locally once you have Node, or use `npm install` in the
   build command if you don't).

## 3. Verify the Render URL works before touching DNS

```bash
curl https://mail-mcp-oauth-XXXX.onrender.com/health
```

Should return `{"status":"ok",...}`. Confirm `accounts` lists your 3
configured mailboxes.

## 4. Custom domain on Render

1. Render service → **Settings** → **Custom Domains** → **Add Custom Domain**
   → `mcp-mail.lukasthies.com`.
2. Render shows you the exact DNS target (a CNAME value like
   `mail-mcp-oauth-xxxx.onrender.com`, or an ALIAS/ANAME record if using
   the root domain — we're using a subdomain so CNAME applies).

**If Render keeps saying "we weren't able to verify" after DNS is
provably correct** (checked at every public resolver *and* directly
against the domain's own authoritative nameservers, `+norecurse`, `aa`
flag set): this happened here — DNS was correct within minutes, Render's
own verification stayed stuck on "not verified" for a long time
regardless of removing/re-adding the domain or waiting. No fix from our
side changed it faster than just... waiting further, and Render reported
no incident on their status page. Don't burn time on more DNS changes
once external tools confirm it's correct — either wait it out, or
(what we did) run against the plain `*.onrender.com` URL in the
meantime and switch `PUBLIC_URL` + the Claude.ai connector URL over once
the custom domain actually goes green.

## 5. DNS at Netcup

1. Netcup CCP → **Domains** → `lukasthies.com` → DNS-Verwaltung.
2. Add a new record:
   - Type: `CNAME`
   - Hostname: `mcp-mail`
   - Destination: the target Render gave you in step 4 (exactly, including trailing dot if Netcup's UI wants one)
   - TTL: default is fine
3. Save. Propagation is usually fast (minutes) but can take up to ~24h.

## 6. Wait for TLS + verify

Render auto-issues a Let's Encrypt cert once DNS resolves correctly. Check
status on the Custom Domains page (it flips from "Pending" to "Verified").
Then:

```bash
curl https://mcp-mail.lukasthies.com/health
```

## 7. Add the connector in Claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**
2. URL: `https://mcp-mail.lukasthies.com/mcp`
3. Claude.ai discovers the OAuth endpoints via
   `/.well-known/oauth-authorization-server`, registers itself via
   `/register`, then opens the `/authorize` login popup.
4. Log in with the `OAUTH_USER` / `OAUTH_PASS` you set in step 2.
5. Tools should appear on the connector. Try `list_accounts` first, then
   `list_folders` / `list_messages` against one mailbox.

## 8. Live-test checklist

- [x] `list_accounts` returns all mailboxes, no credentials leaked
- [x] `list_folders` works per account
- [x] `list_messages` / `search_messages` on INBOX for each account
- [x] `send_message` — real test email from each account, confirmed delivered with the *real* From address (needs Brevo domain authentication per account's domain — see docs/ACCOUNTS.md; Gmail can't be domain-authenticated this way and is deferred)
- [x] `create_draft`, `mark_read` — pure IMAP, unaffected by the SMTP block
- [x] Unauthenticated `POST /mcp` returns 401 with a `WWW-Authenticate` header
- [ ] `move_message` / `delete_message`
- [ ] Re-open the connector in a new Claude.ai session after the Render free
      instance goes idle — confirms cold start + re-auth work
- [ ] Switch `PUBLIC_URL` + connector URL from `*.onrender.com` to the
      custom domain once Render's verification actually goes green

## Known issues found during live testing (fixed)

- **`npm ci` failing on first deploy** — no `package-lock.json` was
  committed (never had local Node access to generate one until later in
  this process). Fixed by generating and committing the lockfile.
- **`send_message` → `ENETUNREACH`** — nodemailer resolves a mail host's
  A *and* AAAA records and picks **at random** between them
  (`nodemailer/lib/shared/index.js`, `formatDNSValue`). Render has no
  IPv6 route, so ~50% of sends failed. Fixed by resolving to a concrete
  IPv4 address ourselves (`dns.lookup(host, {family:4})`) and connecting
  to that directly, before discovering the deeper issue below.
- **`send_message` → `Connection timeout` even after the above** — Render's
  free tier blocks outbound SMTP ports entirely (25/465/587), independent
  of DNS/IPv4/IPv6. No amount of client-side fixing gets around a platform
  firewall rule. Fixed by routing sends through Brevo's HTTPS API instead.
- **`search_messages` returning duplicate entries with all-null fields** —
  `imap-client.ts` was handing ImapFlow's `fetch()` a *descending* UID
  list (built by reversing before the fetch call); ascending is what
  IMAP servers expect for a multi-UID range. Fixed by fetching ascending
  and reversing the *result array* afterward, matching `listMessages`'
  already-correct pattern.
