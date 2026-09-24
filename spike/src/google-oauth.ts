/**
 * Google OAuth2 access-token refresh for IMAP XOAUTH2 -- straight port of
 * mail-mcp-oauth's src/google-oauth.ts. Already portable as-is: it only
 * ever used `fetch`, never a Node API.
 *
 * The in-memory cache is a best-effort optimization within one isolate's
 * lifetime, not a correctness requirement -- a Worker can be evicted
 * between requests at any time, so a refresh on a "cold" isolate is
 * expected and fine (one extra fetch to Google, well under the free
 * plan's 50-subrequest cap).
 */

export interface GoogleOAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

export async function getGoogleAccessToken(creds: GoogleOAuthCreds): Promise<string> {
  const key = creds.refreshToken;
  const cached = cache.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.accessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google token refresh failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cache.set(key, { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}
