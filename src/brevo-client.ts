/**
 * Brevo (formerly Sendinblue) transactional email API client.
 *
 * Render's free tier blocks outbound traffic to SMTP ports (25/465/587)
 * entirely — direct SMTP sending never connects, regardless of provider
 * (confirmed against Gmail and two Netcup mailboxes alike). Brevo's send
 * API is plain HTTPS (443), which isn't blocked, so this replaces the
 * network leg of send_message only. IMAP (993, reading + APPEND for
 * create_draft and the Sent-folder copy) is unaffected and unchanged.
 *
 * One Brevo account/API key covers all mailboxes — Brevo just needs each
 * "from" address individually verified once (Senders -> confirmation
 * email), not a whole domain.
 */

import { OutgoingMessage } from "./smtp-client.js";

export interface BrevoSendResult {
  messageId: string;
}

interface BrevoAddress {
  email: string;
  name?: string;
}

function parseAddress(raw: string): BrevoAddress {
  const match = /^(.*)<([^<>]+)>$/.exec(raw.trim());
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    return name ? { email: match[2].trim(), name } : { email: match[2].trim() };
  }
  return { email: raw.trim() };
}

function toAddressList(value: string | string[] | undefined): BrevoAddress[] | undefined {
  if (!value) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(parseAddress);
}

export class BrevoClient {
  constructor(private readonly apiKey: string) {}

  async send(
    msg: OutgoingMessage,
    from: { email: string; name?: string }
  ): Promise<BrevoSendResult> {
    const body: Record<string, unknown> = {
      sender: from,
      to: toAddressList(msg.to),
      subject: msg.subject,
    };
    const cc = toAddressList(msg.cc);
    if (cc) body.cc = cc;
    const bcc = toAddressList(msg.bcc);
    if (bcc) body.bcc = bcc;
    if (msg.text) body.textContent = msg.text;
    if (msg.html) body.htmlContent = msg.html;
    if (!msg.text && !msg.html) body.textContent = "";
    if (msg.replyTo) body.replyTo = parseAddress(msg.replyTo);

    const headers: Record<string, string> = {};
    if (msg.inReplyTo) headers["In-Reply-To"] = msg.inReplyTo;
    if (msg.references && msg.references.length > 0) headers["References"] = msg.references.join(" ");
    if (Object.keys(headers).length > 0) body.headers = headers;

    if (msg.attachments && msg.attachments.length > 0) {
      body.attachment = msg.attachments.map((a) => ({
        content: a.contentBase64,
        name: a.filename,
      }));
    }

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        detail = await res.text().catch(() => "");
      }
      throw new Error(`Brevo send failed (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as { messageId?: string };
    return { messageId: data.messageId ?? "" };
  }
}
