# mail-mcp-spike — Phase 0 Go/No-Go

Throwaway Worker. Answers one question before Phase 1 (the full port)
starts: does `imapflow` work under Cloudflare Workers' `nodejs_compat`,
and what does it cost in CPU-ms and bundle bytes on the Free plan?

Two tools only: `list_folders`, `list_messages` (default limit 5). No
OAuth 2.1 layer (that's Phase 1) — `/mcp` is gated by a single shared
bearer token (`SPIKE_TOKEN`) instead, so real IMAP credentials aren't
sitting behind an unauthenticated public `workers.dev` URL while this is
up.

## 1. Install & typecheck

```sh
cd spike
npm install
npm run typecheck
```

## 2. Bundle size (no Cloudflare account needed)

```sh
npm run dry-run
```

`wrangler deploy --dry-run` only builds the bundle, it doesn't need
Cloudflare auth. Its output prints `Total Upload: X KiB / gzip: Y KiB` —
that gzip figure is the Go/No-Go bundle number (need < 2.5 MB gzip,
Free-plan hard cap is 3 MB gzip).

## 3. Deploy (needs a Cloudflare account)

```sh
npx wrangler login          # or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put SPIKE_TOKEN      # any random string, e.g. `openssl rand -hex 24`
npx wrangler secret put ACCOUNTS_JSON    # see schema below — paste as one line
npm run deploy
```

`ACCOUNTS_JSON` schema (version 1, same shape as the Render app's, minus
`smtp`/`mail` since this spike is read-only):

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "gmail",
      "label": "Gmail test account",
      "default": true,
      "imap": { "host": "imap.gmail.com", "port": 993, "user": "you@gmail.com", "pass": "", "tls": true },
      "google": { "clientId": "...", "clientSecret": "...", "refreshToken": "..." }
    },
    {
      "id": "netcup",
      "label": "Netcup test account",
      "imap": { "host": "your.netcup.imap.host", "port": 993, "user": "you@yourdomain", "pass": "app-password", "tls": true }
    }
  ]
}
```

Use one Google account (`imap.pass: ""` + `google` block → XOAUTH2 path)
and one Netcup-style account (`imap.pass` set → plain password path) to
exercise both auth methods the real connector needs.

Never put real values from this file in chat or in the repo — set them
directly with `wrangler secret put`.

## 4. Measure CPU time over 20 calls

```sh
SPIKE_URL=https://mail-mcp-spike.<your-subdomain>.workers.dev \
SPIKE_TOKEN=<the token you set above> \
MAILBOX=INBOX \
ACCOUNT=gmail \
npm run bench
```

Repeat with `ACCOUNT=netcup` for the second auth path. The script starts
`wrangler tail --format=json` alongside the 2×20 calls to capture the
platform's own reported CPU time per invocation (Workers Free enforces
10ms CPU/request and returns error code 1102 past it — client-observed
wall-clock latency is NOT the number that matters here, it also includes
network RTT). If your installed `wrangler` version names that JSON field
differently than expected, the script prints one raw captured event so
you can adjust `extractCpuMs()` in `scripts/bench.mjs`; the full capture
is also saved to `spike/.tail-capture.jsonl`. Cross-check against the
Cloudflare dashboard (Workers & Pages → mail-mcp-spike → Metrics → CPU
time) if in doubt.

## Go / No-Go

- **Go**: imapflow connects and returns real folder/message data for
  both accounts, p95 CPU < 8ms, bundle < 2.5 MB gzip → proceed to Phase 1
  (full port: OAuth 2.1 via `jose`, KV for auth codes + Google token
  cache, all 10 tools, postal-mime/mimetext if mailparser/nodemailer
  don't fit the bundle, docs rewrite, keepalive removal).
- **No-Go**: any criterion fails → stop, report the actual numbers and
  the failure mode (which account/auth path failed, or which limit was
  exceeded), and list alternatives (a slimmer IMAP client, Cloudflare's
  paid plan, staying on Render) instead of continuing to Phase 1.
