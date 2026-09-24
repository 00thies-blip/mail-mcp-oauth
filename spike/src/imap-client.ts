/**
 * IMAP client wrapper around imapflow -- trimmed spike version.
 *
 * Unlike mail-mcp-oauth's src/imap-client.ts (long-lived connection,
 * reused across requests via ClientPool), this opens ONE connection per
 * call and the caller closes it in a `finally` -- there is no
 * cross-request state on Workers to cache a connection in, and Phase 1's
 * design carries this same per-request-connect pattern into the real
 * port (see wrangler-workers.md notes). This is also the honest way to
 * measure real per-request CPU cost for the Go/No-Go decision: including
 * TLS handshake + login on every call, not just the fast path after a
 * warm connection.
 */
import { ImapFlow, type FetchMessageObject } from "imapflow";

export interface ImapAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  accessTokenProvider?: () => Promise<string>;
}

export interface MailboxSummary {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  subscribed: boolean;
}

export interface MessageSummary {
  uid: number;
  seq: number;
  flags: string[];
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  size: number | null;
}

/**
 * imapflow's own connectionTimeout (default 90s) did not reliably abort a
 * stuck connect() when tested live on Workers -- a call to a real IMAP
 * host hung well past 90s with no error surfacing. Wrap connect() in an
 * independent timeout that does not depend on imapflow's internal timer
 * firing correctly under this runtime, so a stuck TCP/TLS handshake fails
 * fast and visibly instead of hanging the request indefinitely.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class ImapClient {
  private client: ImapFlow | null = null;

  constructor(private readonly auth: ImapAuth) {}

  async connect(): Promise<void> {
    const auth = this.auth.accessTokenProvider
      ? { user: this.auth.user, accessToken: await this.auth.accessTokenProvider() }
      : { user: this.auth.user, pass: this.auth.pass };
    const client = new ImapFlow({
      host: this.auth.host,
      port: this.auth.port,
      secure: this.auth.secure,
      auth,
      logger: false,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
    });
    await withTimeout(client.connect(), 10000, `IMAP connect to ${this.auth.host}:${this.auth.port} timed out after 10s`);
    this.client = client;
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    try {
      await c.logout();
    } catch {
      // best effort
    }
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    const client = this.require();
    const list = await client.list();
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter ?? "/",
      flags: Array.from(m.flags ?? []),
      specialUse: m.specialUse ?? undefined,
      subscribed: Boolean(m.subscribed),
    }));
  }

  async listMessages(mailbox: string, limit = 5): Promise<MessageSummary[]> {
    const client = this.require();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const status = await client.status(mailbox, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) return [];
      const from = Math.max(1, total - Math.min(limit, 200) + 1);
      const out: MessageSummary[] = [];
      for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, internalDate: true, size: true })) {
        out.push(summarize(msg));
      }
      return out.reverse();
    } finally {
      lock.release();
    }
  }

  private require(): ImapFlow {
    if (!this.client) throw new Error("ImapClient.connect() must be called first");
    return this.client;
  }
}

function addrText(addr: { name?: string; address?: string }[] | { name?: string; address?: string } | undefined): string | null {
  if (!addr) return null;
  const list = Array.isArray(addr) ? addr : [addr];
  return (
    list
      .map((a) => {
        const name = a?.name?.trim();
        const email = a?.address?.trim();
        if (name && email) return `${name} <${email}>`;
        return email ?? name ?? null;
      })
      .filter((v): v is string => Boolean(v))
      .join(", ") || null
  );
}

function summarize(msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope;
  return {
    uid: msg.uid as number,
    seq: msg.seq as number,
    flags: Array.from(msg.flags ?? []),
    date: env?.date ? new Date(env.date).toISOString() : null,
    subject: env?.subject ?? null,
    from: addrText(env?.from),
    to: addrText(env?.to),
    size: (msg.size as number | undefined) ?? null,
  };
}
