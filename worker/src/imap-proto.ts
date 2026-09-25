/**
 * IMAP4rev1 wire format (RFC 3501) -- the parsing half, free of any I/O so it
 * can be unit-tested against captured server responses.
 *
 * Why hand-rolled: imapflow runs on Node's net/tls, and under Workers'
 * nodejs_compat its connect() hangs (Phase 0 spike: timeout on every host)
 * while cloudflare:sockets reaches the same hosts in 30-400 ms. The protocol
 * slice this connector needs is small and well specified, so owning it is
 * less risk than depending on a compat layer.
 *
 * Value model:
 *   atom / quoted string -> string
 *   literal {n}           -> Uint8Array (raw bytes, e.g. a whole RFC 822 message)
 *   NIL                   -> null
 *   parenthesised list    -> ImapValue[]
 */

export type ImapValue = string | Uint8Array | null | ImapValue[];

export interface StatusResponse {
  kind: "status";
  tag: string; // "*" for untagged
  status: "OK" | "NO" | "BAD" | "BYE" | "PREAUTH";
  code: string | null; // text inside [...] if present, e.g. "CAPABILITY IMAP4rev1 ..."
  text: string;
}

export interface DataResponse {
  kind: "data";
  tokens: ImapValue[]; // everything after "* "
}

export interface ContinuationResponse {
  kind: "continuation";
  text: string;
}

export type ImapResponse = StatusResponse | DataResponse | ContinuationResponse;

const CR = 13;
const LF = 10;
const SP = 32;
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

/**
 * Find the end of the first complete response in `buf` (including any
 * literals it announces). Returns the byte length, or -1 if more data is needed.
 */
export function completeResponseLength(buf: Uint8Array): number {
  let pos = 0;
  for (;;) {
    const lf = buf.indexOf(LF, pos);
    if (lf === -1) return -1;
    // A line ending in {n} or {n+} announces n bytes of literal data after the CRLF.
    const lineEnd = lf > 0 && buf[lf - 1] === CR ? lf - 1 : lf;
    let n = -1;
    if (lineEnd > 0 && buf[lineEnd - 1] === 0x7d /* } */) {
      let i = lineEnd - 2;
      if (buf[i] === 0x2b /* + */) i--;
      let digits = "";
      while (i >= 0 && buf[i]! >= 0x30 && buf[i]! <= 0x39) digits = String.fromCharCode(buf[i--]!) + digits;
      if (i >= 0 && buf[i] === 0x7b /* { */ && digits) n = Number(digits);
    }
    if (n < 0) return lf + 1;
    const next = lf + 1 + n;
    if (next > buf.length) return -1;
    pos = next;
  }
}

/** Parse one complete response (as delimited by completeResponseLength). */
export function parseResponse(bytes: Uint8Array): ImapResponse & { tag?: string } {
  if (bytes[0] === 0x2b /* + */) {
    return { kind: "continuation", text: latin1.decode(bytes.subarray(1)).trim() };
  }
  const t = new Tokenizer(bytes);
  const tag = t.atom();
  t.skipSpaces();
  const save = t.pos;
  const word = t.atom().toUpperCase();
  if (word === "OK" || word === "NO" || word === "BAD" || word === "BYE" || word === "PREAUTH") {
    const rest = utf8.decode(bytes.subarray(t.pos)).replace(/\r?\n$/, "").trim();
    const m = /^\[([^\]]*)\]\s*(.*)$/s.exec(rest);
    return { kind: "status", tag, status: word, code: m ? m[1]! : null, text: m ? m[2]! : rest };
  }
  if (tag !== "*") {
    throw new Error(`Unexpected tagged response: ${latin1.decode(bytes).slice(0, 120)}`);
  }
  t.pos = save;
  return { kind: "data", tokens: t.values() };
}

class Tokenizer {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}

  skipSpaces(): void {
    while (this.pos < this.b.length && this.b[this.pos] === SP) this.pos++;
  }

  private atEnd(): boolean {
    const c = this.b[this.pos];
    return c === undefined || c === CR || c === LF;
  }

  /** Values until end of line (top level) or until ')' (inside a list). */
  values(inList = false): ImapValue[] {
    const out: ImapValue[] = [];
    for (;;) {
      this.skipSpaces();
      if (this.atEnd()) {
        if (inList) throw new Error("Unterminated list in IMAP response");
        return out;
      }
      const c = this.b[this.pos]!;
      if (c === 0x29 /* ) */) {
        if (!inList) throw new Error("Unbalanced ')' in IMAP response");
        this.pos++;
        return out;
      }
      out.push(this.value());
    }
  }

  value(): ImapValue {
    const c = this.b[this.pos]!;
    if (c === 0x28 /* ( */) {
      this.pos++;
      return this.values(true);
    }
    if (c === 0x22 /* " */) return this.quoted();
    if (c === 0x7b /* { */) return this.literal();
    const a = this.atom();
    return a.toUpperCase() === "NIL" ? null : a;
  }

  private quoted(): string {
    this.pos++; // opening quote
    const bytes: number[] = [];
    while (this.pos < this.b.length) {
      const c = this.b[this.pos++]!;
      if (c === 0x5c /* \ */) {
        bytes.push(this.b[this.pos++]!);
      } else if (c === 0x22) {
        return utf8.decode(new Uint8Array(bytes));
      } else {
        bytes.push(c);
      }
    }
    throw new Error("Unterminated quoted string in IMAP response");
  }

  private literal(): Uint8Array {
    const close = this.b.indexOf(0x7d, this.pos);
    const n = Number(latin1.decode(this.b.subarray(this.pos + 1, close)).replace("+", ""));
    let p = close + 1;
    if (this.b[p] === CR) p++;
    if (this.b[p] === LF) p++;
    const data = this.b.slice(p, p + n);
    this.pos = p + n;
    return data;
  }

  /**
   * An atom. Square brackets are part of the atom and may contain spaces and
   * parentheses (BODY[HEADER.FIELDS (DATE FROM)]<0> is ONE key in a FETCH response).
   */
  atom(): string {
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.b.length) {
      const c = this.b[this.pos]!;
      if (c === 0x5b /* [ */) depth++;
      else if (c === 0x5d /* ] */) depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === SP || c === 0x28 || c === 0x29 || c === CR || c === LF)) break;
      this.pos++;
    }
    return latin1.decode(this.b.subarray(start, this.pos));
  }
}

// ---------------------------------------------------------------- helpers

export function asText(v: ImapValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return utf8.decode(v);
  return null;
}

/** Turn a FETCH item list (K V K V ...) into a map with upper-cased keys. */
export function fetchMap(list: ImapValue[]): Map<string, ImapValue> {
  const m = new Map<string, ImapValue>();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const k = list[i];
    if (typeof k === "string") m.set(k.toUpperCase(), list[i + 1]!);
  }
  return m;
}

/** Quote a string for use as an IMAP astring (only valid for 7-bit text without CR/LF). */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function isAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

// ------------------------------------------------ modified UTF-7 (RFC 3501 5.1.3)

export function encodeMailboxName(name: string): string {
  let out = "";
  let buf: number[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const bytes = new Uint8Array(buf.length * 2);
    buf.forEach((u, i) => {
      bytes[i * 2] = u >> 8;
      bytes[i * 2 + 1] = u & 0xff;
    });
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    out += "&" + btoa(bin).replace(/=+$/, "").replace(/\//g, ",") + "-";
    buf = [];
  };
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) {
      flush();
      out += ch === "&" ? "&-" : ch;
    } else {
      // UTF-16 code units (surrogate pairs for astral characters)
      for (let i = 0; i < ch.length; i++) buf.push(ch.charCodeAt(i));
    }
  }
  flush();
  return out;
}

export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (b64 === "") return "&";
    const bin = atob(b64.replace(/,/g, "/") + "===".slice((b64.length + 3) % 4));
    let s = "";
    for (let i = 0; i + 1 < bin.length; i += 2) s += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    return s;
  });
}

// ------------------------------------------------ RFC 2047 encoded words

export function decodeWords(input: string | null): string | null {
  if (input === null) return null;
  // Adjacent encoded words separated only by whitespace are joined without it.
  const joined = input.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?)/g, "$1");
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
    try {
      let bytes: Uint8Array;
      if (enc.toUpperCase() === "B") {
        const bin = atob(data);
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } else {
        const s = data.replace(/_/g, " ");
        const arr: number[] = [];
        for (let i = 0; i < s.length; i++) {
          if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
            arr.push(parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
          } else arr.push(s.charCodeAt(i));
        }
        bytes = new Uint8Array(arr);
      }
      return new TextDecoder(charset.split("*")[0]!.toLowerCase()).decode(bytes);
    } catch {
      return whole;
    }
  });
}

// ------------------------------------------------ ENVELOPE / BODYSTRUCTURE

export interface Envelope {
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  messageId: string | null;
  inReplyTo: string | null;
}

function addressList(v: ImapValue | undefined): string | null {
  if (!Array.isArray(v)) return null;
  const parts: string[] = [];
  for (const a of v) {
    if (!Array.isArray(a)) continue;
    const name = decodeWords(asText(a[0]))?.trim();
    const mailbox = asText(a[2]);
    const host = asText(a[3]);
    if (!mailbox) continue; // group syntax markers
    const email = host ? `${mailbox}@${host}` : mailbox;
    parts.push(name ? `${name} <${email}>` : email);
  }
  return parts.length ? parts.join(", ") : null;
}

export function parseEnvelope(v: ImapValue | undefined): Envelope {
  const e = Array.isArray(v) ? v : [];
  const rawDate = asText(e[0]);
  const d = rawDate ? new Date(rawDate.replace(/\s*\([^)]*\)\s*$/, "")) : null;
  return {
    date: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
    subject: decodeWords(asText(e[1])),
    from: addressList(e[2]),
    to: addressList(e[5]),
    cc: addressList(e[6]),
    inReplyTo: asText(e[8]),
    messageId: asText(e[9]),
  };
}

export interface TextPart {
  path: string; // "1", "1.2", ... ("1" also for a single-part message)
  subtype: string; // "plain" | "html"
  encoding: string; // "base64", "quoted-printable", "7bit", ...
  charset: string;
}

/** First text/plain part (preferred) or text/html part of a BODYSTRUCTURE. */
export function findTextPart(bs: ImapValue | undefined): TextPart | null {
  let html: TextPart | null = null;
  const walk = (node: ImapValue | undefined, path: string): TextPart | null => {
    if (!Array.isArray(node)) return null;
    if (Array.isArray(node[0])) {
      // multipart: children first, then subtype string
      let i = 0;
      for (; i < node.length && Array.isArray(node[i]); i++) {
        const found = walk(node[i], path ? `${path}.${i + 1}` : `${i + 1}`);
        if (found) return found;
      }
      return null;
    }
    const type = (asText(node[0]) ?? "").toLowerCase();
    const subtype = (asText(node[1]) ?? "").toLowerCase();
    if (type !== "text" || (subtype !== "plain" && subtype !== "html")) return null;
    const params = Array.isArray(node[2]) ? node[2] : [];
    let charset = "utf-8";
    for (let i = 0; i + 1 < params.length; i += 2) {
      if ((asText(params[i]) ?? "").toLowerCase() === "charset") charset = (asText(params[i + 1]) ?? "utf-8").toLowerCase();
    }
    const part: TextPart = { path: path || "1", subtype, encoding: (asText(node[5]) ?? "7bit").toLowerCase(), charset };
    if (subtype === "plain") return part;
    html ??= part;
    return null;
  };
  return walk(bs, "") ?? html;
}

/** Decode a (possibly truncated) body part to readable text for previews. */
export function decodePartPreview(bytes: Uint8Array, part: TextPart, maxChars = 200): string {
  let raw = bytes;
  if (part.encoding === "base64") {
    const clean = latin1.decode(bytes).replace(/[^A-Za-z0-9+/=]/g, "").replace(/=+$/, (m) => m.slice(0, 2));
    const usable = clean.slice(0, clean.length - (clean.length % 4));
    try {
      raw = Uint8Array.from(atob(usable), (c) => c.charCodeAt(0));
    } catch {
      raw = new Uint8Array();
    }
  } else if (part.encoding === "quoted-printable") {
    const s = latin1.decode(bytes).replace(/=\r?\n/g, "");
    const arr: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        arr.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else arr.push(s.charCodeAt(i) & 0xff);
    }
    raw = new Uint8Array(arr);
  }
  let text: string;
  try {
    text = new TextDecoder(part.charset).decode(raw);
  } catch {
    text = utf8.decode(raw);
  }
  if (part.subtype === "html") {
    text = text
      .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(style|script|head|title)\b[\s\S]*$/i, "")
      .replace(/<!--[\s\S]*?(-->|$)/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/<[^>]*$/, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return text.replace(/�+$/, "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** "25-Sep-2026 10:35:58 +0000" -> ISO string. */
export function parseInternalDate(v: ImapValue | undefined): string | null {
  const s = asText(v);
  if (!s) return null;
  const d = new Date(s.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, "$1 $2 $3"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** YYYY-MM-DD -> IMAP search date "25-Sep-2026". */
export function imapDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d}-${mon}-${y}`;
}
