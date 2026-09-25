/**
 * High-level IMAP operations for the mail tools. Output shapes match the
 * Render version (src/imap-client.ts at the repo root) so Claude sees the
 * same JSON as before the move.
 */
import PostalMime from "postal-mime";
import { utf8ToBase64 } from "./base64.js";
import { ImapConnection, ImapError } from "./imap-conn.js";
import {
  asText,
  decodeMailboxName,
  decodePartPreview,
  encodeMailboxName,
  fetchMap,
  findTextPart,
  imapDate,
  isAscii,
  parseEnvelope,
  parseInternalDate,
  quote,
  type ImapValue,
  type TextPart,
} from "./imap-proto.js";
import type { CommandPart } from "./imap-conn.js";

export interface ImapAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
  accessTokenProvider?: () => Promise<string>;
}

export interface MailboxSummary {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  subscribed: boolean;
  listed: boolean;
}

export interface MessageSummary {
  uid: number;
  seq: number;
  flags: string[];
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  size: number | null;
  preview: string | null;
}

export interface MessageDetail extends MessageSummary {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{ filename: string | null; contentType: string; size: number; contentId: string | null }>;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string;
  before?: string;
  unread?: boolean;
  flagged?: boolean;
}

const SPECIAL_USE = ["\\All", "\\Archive", "\\Drafts", "\\Flagged", "\\Junk", "\\Sent", "\\Trash"];

function mailboxArg(path: string): string {
  return quote(encodeMailboxName(path));
}

function numbers(tokens: ImapValue[]): number[] {
  return tokens.filter((t): t is string => typeof t === "string" && /^\d+$/.test(t)).map(Number);
}

/** Opens, authenticates, runs `fn`, always logs out. One connection per tool call. */
export async function withImap<T>(auth: ImapAuth, fn: (c: ImapClient) => Promise<T>): Promise<T> {
  const conn = await ImapConnection.open(auth.host, auth.port, auth.tls);
  try {
    const client = new ImapClient(conn);
    await client.login(auth);
    return await fn(client);
  } finally {
    await conn.logout();
  }
}

export class ImapClient {
  private selected: { path: string; readOnly: boolean; exists: number } | null = null;

  constructor(private readonly conn: ImapConnection) {}

  async login(auth: ImapAuth): Promise<void> {
    if (auth.accessTokenProvider) {
      const token = await auth.accessTokenProvider();
      await this.conn.authenticate("XOAUTH2", utf8ToBase64(`user=${auth.user}\x01auth=Bearer ${token}\x01\x01`));
    } else if (this.conn.has("AUTH=PLAIN")) {
      await this.conn.authenticate("PLAIN", utf8ToBase64(`\x00${auth.user}\x00${auth.pass}`));
    } else {
      const arg = (s: string): CommandPart => (isAscii(s) ? quote(s) : { literal: new TextEncoder().encode(s) });
      await this.conn.command(["LOGIN", arg(auth.user), arg(auth.pass)]);
    }
    // Capabilities often change after login (e.g. MOVE, UIDPLUS only advertised then).
    await this.conn.refreshCapabilities();
  }

  private async open(path: string, readOnly: boolean): Promise<number> {
    if (this.selected && this.selected.path === path && (readOnly || !this.selected.readOnly)) return this.selected.exists;
    const r = await this.conn.command([readOnly ? "EXAMINE" : "SELECT", mailboxArg(path)]);
    let exists = 0;
    for (const d of r.data) {
      if (d.tokens[1] === "EXISTS" && typeof d.tokens[0] === "string") exists = Number(d.tokens[0]);
    }
    this.selected = { path, readOnly, exists };
    return exists;
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    const listed = await this.conn.command(['LIST "" "*"']);
    const subscribed = new Set<string>();
    try {
      const lsub = await this.conn.command(['LSUB "" "*"']);
      for (const d of lsub.data) if (d.tokens[0] === "LSUB") subscribed.add(asText(d.tokens[3]) ?? "");
    } catch {
      // LSUB is optional in IMAP4rev2 servers
    }
    const out: MailboxSummary[] = [];
    for (const d of listed.data) {
      if (d.tokens[0] !== "LIST") continue;
      const flags = (Array.isArray(d.tokens[1]) ? d.tokens[1] : []).filter((f): f is string => typeof f === "string");
      const delimiter = asText(d.tokens[2]) ?? "/";
      const raw = asText(d.tokens[3]) ?? "";
      const path = decodeMailboxName(raw);
      const special = flags.find((f) => SPECIAL_USE.includes(f));
      out.push({
        path,
        name: path.split(delimiter).pop() ?? path,
        delimiter,
        flags,
        specialUse: special ?? (path.toUpperCase() === "INBOX" ? "\\Inbox" : undefined),
        subscribed: subscribed.has(raw),
        listed: true,
      });
    }
    return out;
  }

  async listMessages(mailbox: string, opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<MessageSummary[]> {
    const limit = Math.min(opts.limit ?? 25, 200);
    const total = await this.open(mailbox, true);
    if (total === 0) return [];
    if (opts.unreadOnly) {
      const uids = await this.search(["UNSEEN"]);
      if (uids.length === 0) return [];
      return this.summaries(uids.slice(-limit).join(","), true);
    }
    const from = Math.max(1, total - limit + 1);
    return this.summaries(`${from}:*`, false);
  }

  async searchMessages(mailbox: string, criteria: SearchCriteria, limit = 25): Promise<MessageSummary[]> {
    await this.open(mailbox, true);
    const parts: CommandPart[] = [];
    let needsUtf8 = false;
    const str = (key: string, value: string) => {
      parts.push(key);
      if (isAscii(value)) parts.push(quote(value));
      else {
        needsUtf8 = true;
        parts.push({ literal: new TextEncoder().encode(value) });
      }
    };
    if (criteria.from) str("FROM", criteria.from);
    if (criteria.to) str("TO", criteria.to);
    if (criteria.subject) str("SUBJECT", criteria.subject);
    if (criteria.body) str("BODY", criteria.body);
    if (criteria.since) parts.push(`SINCE ${imapDate(criteria.since)}`);
    if (criteria.before) parts.push(`BEFORE ${imapDate(criteria.before)}`);
    if (criteria.unread === true) parts.push("UNSEEN");
    if (criteria.unread === false) parts.push("SEEN");
    if (criteria.flagged === true) parts.push("FLAGGED");
    if (criteria.flagged === false) parts.push("UNFLAGGED");
    if (parts.length === 0) parts.push("ALL");
    const uids = await this.search(needsUtf8 ? ["CHARSET UTF-8", ...parts] : parts);
    if (uids.length === 0) return [];
    return this.summaries(uids.slice(-Math.min(limit, 200)).join(","), true);
  }

  private async search(criteria: CommandPart[]): Promise<number[]> {
    const r = await this.conn.command(["UID SEARCH", ...criteria]);
    const out: number[] = [];
    for (const d of r.data) {
      if (d.tokens[0] === "SEARCH") out.push(...numbers(d.tokens.slice(1)));
    }
    return out.sort((a, b) => a - b);
  }

  /** Envelope + flags + a short text preview; newest first. */
  private async summaries(set: string, byUid: boolean): Promise<MessageSummary[]> {
    const r = await this.conn.command([`${byUid ? "UID " : ""}FETCH ${set} (UID FLAGS RFC822.SIZE ENVELOPE BODYSTRUCTURE)`]);
    const items: Array<{ summary: MessageSummary; part: TextPart | null }> = [];
    for (const d of r.data) {
      if (d.tokens[1] !== "FETCH" || !Array.isArray(d.tokens[2])) continue;
      const m = fetchMap(d.tokens[2]);
      const env = parseEnvelope(m.get("ENVELOPE"));
      const flags = m.get("FLAGS");
      items.push({
        summary: {
          uid: Number(asText(m.get("UID")) ?? 0),
          seq: Number(d.tokens[0]),
          flags: Array.isArray(flags) ? flags.filter((f): f is string => typeof f === "string") : [],
          date: env.date,
          subject: env.subject,
          from: env.from,
          to: env.to,
          cc: env.cc,
          size: m.has("RFC822.SIZE") ? Number(asText(m.get("RFC822.SIZE"))) : null,
          preview: null,
        },
        part: findTextPart(m.get("BODYSTRUCTURE")),
      });
    }
    // One partial FETCH per distinct text-part path (usually just "1" and "1.1").
    const byPath = new Map<string, typeof items>();
    for (const it of items) {
      if (!it.part || !it.summary.uid) continue;
      const list = byPath.get(it.part.path) ?? [];
      list.push(it);
      byPath.set(it.part.path, list);
    }
    for (const [path, list] of byPath) {
      const res = await this.conn.command([`UID FETCH ${list.map((i) => i.summary.uid).join(",")} (UID BODY.PEEK[${path}]<0.1200>)`]);
      const byUidMap = new Map(list.map((i) => [i.summary.uid, i]));
      for (const d of res.data) {
        if (d.tokens[1] !== "FETCH" || !Array.isArray(d.tokens[2])) continue;
        const m = fetchMap(d.tokens[2]);
        const it = byUidMap.get(Number(asText(m.get("UID"))));
        const body = [...m.entries()].find(([k]) => k.startsWith("BODY["))?.[1];
        if (it && it.part) {
          const bytes = body instanceof Uint8Array ? body : typeof body === "string" ? new TextEncoder().encode(body) : null;
          it.summary.preview = bytes ? decodePartPreview(bytes, it.part) || null : null;
        }
      }
    }
    return items.map((i) => i.summary).sort((a, b) => b.uid - a.uid || b.seq - a.seq);
  }

  async getMessage(mailbox: string, uid: number): Promise<MessageDetail> {
    await this.open(mailbox, true);
    const r = await this.conn.command([`UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])`]);
    const d = r.data.find((x) => x.tokens[1] === "FETCH" && Array.isArray(x.tokens[2]));
    if (!d) throw new ImapError(`Message UID ${uid} not found in ${mailbox}`);
    const m = fetchMap(d.tokens[2] as ImapValue[]);
    const source = m.get("BODY[]");
    if (!(source instanceof Uint8Array)) throw new ImapError(`Message UID ${uid} has no body`);
    const parsed = await PostalMime.parse(source, { attachmentEncoding: "arraybuffer" });
    const addr = (a: { name?: string; address?: string } | undefined) =>
      a ? (a.name && a.address ? `${a.name} <${a.address}>` : a.address ?? a.name ?? null) : null;
    const addrs = (l: Array<{ name?: string; address?: string }> | undefined) => (l && l.length ? l.map(addr).filter(Boolean).join(", ") : null);
    const flags = m.get("FLAGS");
    const refs = parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : [];
    return {
      uid: Number(asText(m.get("UID")) ?? uid),
      seq: Number(d.tokens[0]),
      flags: Array.isArray(flags) ? flags.filter((f): f is string => typeof f === "string") : [],
      date: parseInternalDate(m.get("INTERNALDATE")),
      subject: parsed.subject ?? null,
      from: addr(parsed.from as { name?: string; address?: string } | undefined),
      to: addrs(parsed.to as Array<{ name?: string; address?: string }> | undefined),
      cc: addrs(parsed.cc as Array<{ name?: string; address?: string }> | undefined),
      size: m.has("RFC822.SIZE") ? Number(asText(m.get("RFC822.SIZE"))) : source.length,
      preview: parsed.text ? parsed.text.slice(0, 200) : null,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: refs,
      bodyText: parsed.text ?? null,
      bodyHtml: parsed.html ?? null,
      attachments: parsed.attachments.map((a) => ({
        filename: a.filename ?? null,
        contentType: a.mimeType,
        size: a.content instanceof ArrayBuffer ? a.content.byteLength : String(a.content).length,
        contentId: a.contentId ?? null,
      })),
    };
  }

  async markRead(mailbox: string, uid: number, read: boolean): Promise<void> {
    await this.open(mailbox, false);
    await this.conn.command([`UID STORE ${uid} ${read ? "+" : "-"}FLAGS.SILENT (\\Seen)`]);
  }

  async moveMessage(source: string, uid: number, destination: string): Promise<void> {
    await this.open(source, false);
    if (this.conn.has("MOVE")) {
      await this.conn.command([`UID MOVE ${uid}`, mailboxArg(destination)]);
      return;
    }
    await this.conn.command([`UID COPY ${uid}`, mailboxArg(destination)]);
    await this.expungeOne(uid);
  }

  async deleteMessage(mailbox: string, uid: number): Promise<void> {
    await this.open(mailbox, false);
    await this.expungeOne(uid);
  }

  private async expungeOne(uid: number): Promise<void> {
    await this.conn.command([`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`]);
    await this.conn.command([this.conn.has("UIDPLUS") ? `UID EXPUNGE ${uid}` : "EXPUNGE"]);
  }

  /** APPEND a raw RFC 822 message (drafts, Sent copy). */
  async append(mailbox: string, raw: Uint8Array, flags: string[]): Promise<void> {
    await this.conn.command(["APPEND", mailboxArg(mailbox), `(${flags.join(" ")})`, { literal: raw }]);
  }
}
