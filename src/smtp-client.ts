/**
 * SMTP client wrapper around nodemailer.
 *
 * Sends RFC-5322 messages and, for create_draft, returns the raw message
 * source so the IMAP client can APPEND it to the Drafts folder.
 */

import { promises as dns } from "node:dns";
import net from "node:net";
import nodemailer, { SendMailOptions } from "nodemailer";

export interface SmtpAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

export interface SmtpDefaults {
  from: string;
  fromName?: string;
}

export interface OutgoingMessage {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  }>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export class SmtpClient {
  private readonly auth: SmtpAuth;
  private readonly defaults: SmtpDefaults;

  constructor(auth: SmtpAuth, defaults: SmtpDefaults) {
    this.auth = auth;
    this.defaults = defaults;
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const mail = this.toMailOptions(msg);
    const transporter = await this.buildTransporter();
    const info = await transporter.sendMail(mail);
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
      response: info.response,
    };
  }

  /**
   * nodemailer resolves both A and AAAA records for a hostname and then
   * picks *at random* between them (see its shared/formatDNSValue) — on a
   * host with no IPv6 route (Render) that fails ~50% of the time with
   * ENETUNREACH even though a working IPv4 address exists. Resolve to a
   * concrete IPv4 address ourselves and connect to that directly, which
   * bypasses nodemailer's resolver/picker entirely. TLS servername has to
   * be set explicitly since we're now connecting to an IP, not a name.
   */
  private async buildTransporter() {
    const host = net.isIP(this.auth.host) ? this.auth.host : await resolveIPv4(this.auth.host);
    return nodemailer.createTransport({
      host,
      port: this.auth.port,
      secure: this.auth.secure,
      auth: { user: this.auth.user, pass: this.auth.pass },
      tls: { servername: this.auth.host },
    });
  }

  /**
   * Build raw RFC 822 source via nodemailer's own composer, without using
   * the SMTP transport. Used by create_draft (APPEND to Drafts folder) and
   * by the "save copy to Sent folder" step after send().
   */
  async buildRawSource(msg: OutgoingMessage): Promise<Buffer> {
    const mail = this.toMailOptions(msg);
    // Lazy import to keep startup light.
    const { default: MailComposer } = await import(
      "nodemailer/lib/mail-composer/index.js"
    );
    const composer = new MailComposer(mail);
    return await new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((err, message) => {
        if (err) reject(err);
        else resolve(message);
      });
    });
  }

  private toMailOptions(msg: OutgoingMessage): SendMailOptions {
    const from = this.defaults.fromName
      ? `"${this.defaults.fromName.replace(/"/g, '\\"')}" <${this.defaults.from}>`
      : this.defaults.from;
    const opts: SendMailOptions = {
      from,
      to: msg.to,
      subject: msg.subject,
    };
    if (msg.cc) opts.cc = msg.cc;
    if (msg.bcc) opts.bcc = msg.bcc;
    if (msg.text) opts.text = msg.text;
    if (msg.html) opts.html = msg.html;
    if (msg.replyTo) opts.replyTo = msg.replyTo;
    if (msg.inReplyTo) opts.inReplyTo = msg.inReplyTo;
    if (msg.references) opts.references = msg.references;
    if (msg.attachments && msg.attachments.length > 0) {
      opts.attachments = msg.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, "base64"),
        contentType: a.contentType,
      }));
    }
    return opts;
  }
}

async function resolveIPv4(hostname: string): Promise<string> {
  // dns.resolve4()/resolve6() (c-ares, raw UDP to the configured
  // nameserver) hangs on Render's network long enough to blow through
  // nodemailer's connection timeout before ever reaching the TCP connect
  // step. dns.lookup() (getaddrinfo, the OS resolver) is what ImapFlow
  // already uses successfully on the same network — use the same path.
  const { address } = await dns.lookup(hostname, { family: 4 });
  return address;
}
