/**
 * Google OAuth2 access-token refresh, shared by IMAP (XOAUTH2) and the
 * Gmail API send path. One refresh_token per mailbox (obtained once via
 * a local script, see docs/ACCOUNTS.md); access tokens are short-lived
 * (~1h) and cached in memory here, refreshed on demand.
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
  // Refresh a little early (60s) rather than racing an in-flight request
  // against the token's actual expiry.
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
  cache.set(key, {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
