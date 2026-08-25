/**
 * Gmail API send path.
 *
 * Render's free tier blocks outbound SMTP ports and Brevo can never
 * authenticate a google.com/gmail.com domain we don't own (see
 * docs/ACCOUNTS.md) — so for Google-hosted mailboxes (Gmail personal,
 * Workspace), sending goes through Gmail's own HTTPS API instead, using
 * the account's own OAuth2 grant. Reuses SmtpClient.buildRawSource() to
 * build the actual RFC-822 message (MIME composition is provider-agnostic;
 * only the "how do I hand this to a server" step differs), then hands the
 * base64url-encoded result to users.messages.send.
 */

import { OutgoingMessage, SmtpClient } from "./smtp-client.js";
import { GoogleOAuthCreds, getGoogleAccessToken } from "./google-oauth.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class GmailApiClient {
  constructor(
    private readonly creds: GoogleOAuthCreds,
    private readonly smtp: SmtpClient
  ) {}

  async send(msg: OutgoingMessage): Promise<{ messageId: string; threadId?: string }> {
    const raw = await this.smtp.buildRawSource(msg);
    const accessToken = await getGoogleAccessToken(this.creds);

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: base64url(raw) }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gmail API send failed (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as { id: string; threadId?: string };
    return { messageId: data.id, threadId: data.threadId };
  }
}
