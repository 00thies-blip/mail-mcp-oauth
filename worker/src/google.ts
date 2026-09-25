/**
 * Google OAuth2 (refresh-token grant) for Gmail/Workspace accounts: XOAUTH2 for
 * IMAP and the Gmail API for sending (a google.com address can only send as
 * itself through Google). Access tokens are cached per isolate.
 */
import { toBase64Url } from "./base64.js";
import type { GoogleOAuthConfig } from "./accounts.js";

const cache = new Map<string, { token: string; expiresAt: number }>();

export async function googleAccessToken(creds: GoogleOAuthConfig): Promise<string> {
  const hit = cache.get(creds.refreshToken);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
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
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cache.set(creds.refreshToken, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

export async function gmailSend(creds: GoogleOAuthConfig, raw: Uint8Array): Promise<{ messageId: string; threadId?: string }> {
  const token = await googleAccessToken(creds);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: toBase64Url(raw) }),
  });
  if (!res.ok) throw new Error(`Gmail API send failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const data = (await res.json()) as { id: string; threadId?: string };
  return { messageId: data.id, threadId: data.threadId };
}
