/**
 * RFC 5322 / MIME message builder (replaces nodemailer's MailComposer).
 * Output is pure 7-bit ASCII: non-ASCII header text becomes RFC 2047 encoded
 * words, bodies and attachments are base64. Used for SMTP, the Gmail API,
 * drafts (APPEND) and the Sent-folder copy.
 */
import { randomHex, toBase64 } from "./base64.js";

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
  attachments?: Array<{ filename: string; contentBase64: string; contentType?: string }>;
}

export interface BuiltMessage {
  raw: Uint8Array;
  messageId: string;
  envelopeFrom: string;
  recipients: string[];
}

const enc = new TextEncoder();

function isAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s);
}

/** RFC 2047 B-encoding, split so each encoded word stays under 75 chars and never splits a UTF-8 sequence. */
export function encodeWord(s: string): string {
  if (isAscii(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) {
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${toBase64(enc.encode(w))}?=`).join("\r\n ");
}

export interface Address {
  name?: string;
  email: string;
}

/** "Name <a@b.c>", "<a@b.c>" or "a@b.c"; commas inside one string separate several addresses. */
export function parseAddresses(input: string | string[] | undefined): Address[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const out: Address[] = [];
  for (const item of list) {
    // Split on commas that are not inside quotes.
    const pieces = item.match(/(?:"[^"]*"|[^,])+/g) ?? [];
    for (const piece of pieces) {
      const p = piece.trim();
      if (!p) continue;
      const m = /^(.*)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(p);
      if (m) {
        const name = m[1]!.trim().replace(/^"(.*)"$/, "$1").trim();
        out.push(name ? { name, email: m[2]! } : { email: m[2]! });
      } else if (/^[^\s@<>]+@[^\s@<>]+$/.test(p)) {
        out.push({ email: p });
      } else {
        throw new Error(`Not a valid e-mail address: ${p}`);
      }
    }
  }
  return out;
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  if (!isAscii(a.name)) return `${encodeWord(a.name)} <${a.email}>`;
  return /^[\w .!#$%&'*+/=?^`{|}~-]*$/.test(a.name) ? `${a.name} <${a.email}>` : `"${a.name.replace(/(["\\])/g, "\\$1")}" <${a.email}>`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n");
}

function b64Text(s: string): string {
  return wrap76(toBase64(enc.encode(s.replace(/\r?\n/g, "\r\n"))));
}

function rfc2822Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function filenameParams(filename: string): { type: string; disposition: string } {
  if (isAscii(filename) && !/["\\\r\n]/.test(filename)) return { type: `name="${filename}"`, disposition: `filename="${filename}"` };
  const star = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return { type: `name="${encodeWord(filename)}"`, disposition: `filename*=UTF-8''${star}` };
}

function boundary(): string {
  return `----=_mailmcp_${randomHex(12)}`;
}

export function buildMessage(msg: OutgoingMessage, from: Address, now = new Date()): BuiltMessage {
  if (!msg.text && !msg.html) throw new Error("Provide at least one of `text` or `html`.");
  const to = parseAddresses(msg.to);
  const cc = parseAddresses(msg.cc);
  const bcc = parseAddresses(msg.bcc);
  if (to.length === 0) throw new Error("At least one recipient in `to` is required.");
  const domain = from.email.split("@")[1] ?? "localhost";
  const messageId = `<${randomHex(16)}@${domain}>`;

  const headers: string[] = [
    `From: ${formatAddress(from)}`,
    `To: ${to.map(formatAddress).join(", ")}`,
  ];
  if (cc.length) headers.push(`Cc: ${cc.map(formatAddress).join(", ")}`);
  if (msg.replyTo) headers.push(`Reply-To: ${parseAddresses(msg.replyTo).map(formatAddress).join(", ")}`);
  headers.push(`Subject: ${encodeWord(msg.subject)}`, `Date: ${rfc2822Date(now)}`, `Message-ID: ${messageId}`);
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references?.length) headers.push(`References: ${msg.references.join(" ")}`);
  headers.push("MIME-Version: 1.0");

  const textPart = (s: string, sub: "plain" | "html") =>
    `Content-Type: text/${sub}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Text(s)}`;

  let body: string;
  if (msg.text && msg.html) {
    const b = boundary();
    body = `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${textPart(msg.text, "plain")}\r\n--${b}\r\n${textPart(msg.html, "html")}\r\n--${b}--\r\n`;
  } else {
    body = msg.html ? textPart(msg.html, "html") : textPart(msg.text!, "plain");
  }

  if (msg.attachments?.length) {
    const b = boundary();
    let mixed = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${body}`;
    for (const a of msg.attachments) {
      const p = filenameParams(a.filename);
      const type = a.contentType || "application/octet-stream";
      const data = a.contentBase64.replace(/\s+/g, "");
      mixed += `\r\n--${b}\r\nContent-Type: ${type}; ${p.type}\r\nContent-Disposition: attachment; ${p.disposition}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(data)}`;
    }
    body = `${mixed}\r\n--${b}--\r\n`;
  }

  const raw = `${headers.join("\r\n")}\r\n${body}`;
  return {
    raw: enc.encode(raw),
    messageId,
    envelopeFrom: from.email,
    recipients: [...to, ...cc, ...bcc].map((a) => a.email),
  };
}
