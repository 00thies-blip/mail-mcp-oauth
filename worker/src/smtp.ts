/**
 * SMTP submission over cloudflare:sockets (replaces nodemailer). Render's free
 * tier blocked ports 465/587, which is why the old version detoured through
 * Brevo; Workers only block port 25, so mail goes straight to the account's
 * own SMTP server again.
 *
 * tls=true  -> implicit TLS (465); tls=false -> plain connect + STARTTLS (587),
 * same meaning as nodemailer's `secure` flag in the Render version.
 */
import { connect } from "cloudflare:sockets";
import { utf8ToBase64 } from "./base64.js";
import type { ServerCreds } from "./accounts.js";

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const TIMEOUT_MS = 20_000;

class SmtpSession {
  private buf = "";
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(private socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** Read one (possibly multi-line) reply. */
  async reply(): Promise<{ code: number; lines: string[] }> {
    const deadline = Date.now() + TIMEOUT_MS;
    const lines: string[] = [];
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, "");
        this.buf = this.buf.slice(nl + 1);
        lines.push(line);
        if (line.length < 4 || line[3] === " ") return { code: Number(line.slice(0, 3)), lines };
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("SMTP server did not answer in time");
      const r = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SMTP server did not answer in time")), left)),
      ]);
      if (r.done) throw new Error("SMTP server closed the connection");
      this.buf += dec.decode(r.value, { stream: true });
    }
  }

  async send(line: string): Promise<void> {
    await this.writer.write(enc.encode(`${line}\r\n`));
  }

  async cmd(line: string, expect: number[], redact = false): Promise<{ code: number; lines: string[] }> {
    await this.send(line);
    const r = await this.reply();
    if (!expect.includes(r.code)) {
      const shown = redact ? line.split(" ").slice(0, 2).join(" ") + " ***" : line;
      throw new Error(`SMTP ${shown} -> ${r.lines.join(" | ")}`);
    }
    return r;
  }

  async writeRaw(bytes: Uint8Array): Promise<void> {
    await this.writer.write(bytes);
  }

  upgrade(): SmtpSession {
    this.reader.releaseLock();
    this.writer.releaseLock();
    return new SmtpSession(this.socket.startTls());
  }

  async close(): Promise<void> {
    try {
      await this.send("QUIT");
    } catch {
      // ignore
    }
    try {
      await this.socket.close();
    } catch {
      // ignore
    }
  }
}

/** Dot-stuffing (RFC 5321 4.5.2) and CRLF line endings. */
export function dotStuff(raw: Uint8Array): Uint8Array {
  const text = dec.decode(raw).replace(/\r?\n/g, "\r\n");
  const stuffed = text.replace(/^\./gm, "..");
  return enc.encode(stuffed.endsWith("\r\n") ? `${stuffed}.\r\n` : `${stuffed}\r\n.\r\n`);
}

/** Connect, upgrade to TLS if needed and log in. Caller must close(). */
async function openAuthenticated(creds: ServerCreds): Promise<SmtpSession> {
  const socket = connect({ hostname: creds.host, port: creds.port }, { secureTransport: creds.tls ? "on" : "starttls", allowHalfOpen: false });
  let s = new SmtpSession(socket);
  try {
    const greet = await s.reply();
    if (greet.code !== 220) throw new Error(`SMTP greeting: ${greet.lines.join(" | ")}`);
    let ehlo = await s.cmd("EHLO mail-mcp.workers.dev", [250]);
    if (!creds.tls) {
      if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) throw new Error(`SMTP server ${creds.host} offers no STARTTLS -- refusing to send the password in clear text`);
      await s.cmd("STARTTLS", [220]);
      s = s.upgrade();
      ehlo = await s.cmd("EHLO mail-mcp.workers.dev", [250]);
    }
    const authLine = ehlo.lines.find((l) => /^250[ -]AUTH[ =]/i.test(l)) ?? "";
    if (/\bPLAIN\b/i.test(authLine) || !/\bLOGIN\b/i.test(authLine)) {
      await s.cmd(`AUTH PLAIN ${utf8ToBase64(`\x00${creds.user}\x00${creds.pass}`)}`, [235], true);
    } else {
      await s.cmd("AUTH LOGIN", [334]);
      await s.cmd(utf8ToBase64(creds.user), [334], true);
      await s.cmd(utf8ToBase64(creds.pass), [235], true);
    }
    return s;
  } catch (err) {
    await s.close();
    throw err;
  }
}

/** Login test for /setup -- sends nothing. */
export async function smtpVerify(creds: ServerCreds): Promise<void> {
  const s = await openAuthenticated(creds);
  await s.close();
}

export async function smtpSend(creds: ServerCreds, envelopeFrom: string, recipients: string[], raw: Uint8Array, messageId: string): Promise<SendResult> {
  const s = await openAuthenticated(creds);
  try {
    await s.cmd(`MAIL FROM:<${envelopeFrom}>`, [250]);
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const rcpt of recipients) {
      await s.send(`RCPT TO:<${rcpt}>`);
      const r = await s.reply();
      (r.code === 250 || r.code === 251 ? accepted : rejected).push(rcpt);
    }
    if (accepted.length === 0) throw new Error(`SMTP server rejected every recipient: ${rejected.join(", ")}`);
    await s.cmd("DATA", [354]);
    await s.writeRaw(dotStuff(raw));
    const done = await s.reply();
    if (done.code !== 250) throw new Error(`SMTP DATA -> ${done.lines.join(" | ")}`);
    return { messageId, accepted, rejected, response: done.lines.join(" ") };
  } finally {
    await s.close();
  }
}
