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
   - `PUBLIC_URL` = `https://mcp-mail.lukasthies.com`
   - `ACCOUNTS_JSON` = the minified accounts.json string
   - `OAUTH_USER` = a username you choose
   - `OAUTH_PASS` = a strong password you choose
   - `JWT_SECRET` = output of `openssl rand -hex 32`
5. Deploy. Watch the build logs for TypeScript errors on first deploy —
   this fork hasn't been build-tested locally (no Node on the dev machine),
   so the first Render build IS the first real compile. Fix and push again
   if it fails; that's expected step 1 of "test live, fix errors".

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

- [ ] `list_accounts` returns all 3 mailboxes, no credentials leaked
- [ ] `list_folders` works per account
- [ ] `list_messages` on INBOX for each account
- [ ] `send_message` — send a real test email from each account and confirm delivery
- [ ] Unauthenticated `POST /mcp` returns 401 with a `WWW-Authenticate` header
- [ ] Re-open the connector in a new Claude.ai session after the Render free
      instance goes idle — confirms cold start + re-auth work
