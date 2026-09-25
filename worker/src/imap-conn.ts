/**
 * One IMAP connection over cloudflare:sockets -- the I/O half (see
 * imap-proto.ts for parsing). Commands run strictly one at a time; a Worker
 * request opens a connection, does its work and logs out, so there is
 * nothing to multiplex.
 */
import { connect } from "cloudflare:sockets";
import { completeResponseLength, parseResponse, type DataResponse, type ImapResponse, type StatusResponse } from "./imap-proto.js";

export type CommandPart = string | { literal: Uint8Array };

export interface CommandResult {
  data: DataResponse[];
  status: StatusResponse;
}

export class ImapError extends Error {
  constructor(message: string, readonly status?: StatusResponse) {
    super(message);
    this.name = "ImapError";
  }
}

const enc = new TextEncoder();
const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 25_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ImapError(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export class ImapConnection {
  capabilities = new Set<string>();
  private socket: Socket;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = new Uint8Array(0);
  private queue: ImapResponse[] = [];
  private waiter: (() => void) | null = null;
  private readError: Error | null = null;
  private tagNo = 0;
  private closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    void this.readLoop(socket.readable.getReader());
  }

  /** Open, read the greeting, upgrade via STARTTLS if `tls` is false. */
  static async open(host: string, port: number, tls: boolean): Promise<ImapConnection> {
    const socket = connect({ hostname: host, port }, { secureTransport: tls ? "on" : "starttls", allowHalfOpen: false });
    let conn = new ImapConnection(socket);
    const greeting = await withTimeout(conn.next(), CONNECT_TIMEOUT_MS, `IMAP connect to ${host}:${port}`);
    if (greeting.kind !== "status" || (greeting.status !== "OK" && greeting.status !== "PREAUTH")) {
      throw new ImapError(`IMAP server ${host} refused the connection`);
    }
    conn.takeCapabilityCode(greeting);
    if (!tls) {
      await conn.command(["STARTTLS"]);
      conn.detach();
      conn = new ImapConnection(socket.startTls());
    }
    if (conn.capabilities.size === 0) await conn.refreshCapabilities();
    return conn;
  }

  private detach(): void {
    this.closed = true;
    this.writer.releaseLock();
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.closed) {
          reader.releaseLock();
          return;
        }
        const merged = new Uint8Array(this.buf.length + value.length);
        merged.set(this.buf);
        merged.set(value, this.buf.length);
        this.buf = merged;
        for (;;) {
          const n = completeResponseLength(this.buf);
          if (n < 0) break;
          this.queue.push(parseResponse(this.buf.subarray(0, n)));
          this.buf = this.buf.slice(n);
        }
        this.wake();
      }
      this.readError ??= new ImapError("IMAP server closed the connection");
    } catch (err) {
      this.readError = err instanceof Error ? err : new Error(String(err));
    }
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private async next(): Promise<ImapResponse> {
    for (;;) {
      const r = this.queue.shift();
      if (r) return r;
      if (this.readError) throw this.readError;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }

  private takeCapabilityCode(s: StatusResponse): void {
    if (s.code && /^CAPABILITY\s/i.test(s.code)) this.setCapabilities(s.code.split(/\s+/).slice(1));
  }

  private setCapabilities(list: string[]): void {
    this.capabilities = new Set(list.map((c) => c.toUpperCase()));
  }

  async refreshCapabilities(): Promise<void> {
    const r = await this.command(["CAPABILITY"]);
    for (const d of r.data) {
      if (typeof d.tokens[0] === "string" && d.tokens[0].toUpperCase() === "CAPABILITY") {
        this.setCapabilities(d.tokens.slice(1).filter((t): t is string => typeof t === "string"));
      }
    }
  }

  has(cap: string): boolean {
    return this.capabilities.has(cap.toUpperCase());
  }

  /**
   * Run one command. Parts are joined with spaces; a { literal } part is sent
   * as {n+} (LITERAL+/LITERAL-) or as a synchronizing literal that waits for
   * the server's "+" continuation.
   */
  async command(parts: CommandPart[], opts: { allowNo?: boolean; timeoutMs?: number } = {}): Promise<CommandResult> {
    const tag = `A${++this.tagNo}`;
    const nonSync = this.has("LITERAL+") || this.has("LITERAL-");
    const run = async (): Promise<CommandResult> => {
      let pending = `${tag} `;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        if (i > 0) pending += " ";
        if (typeof p === "string") {
          pending += p;
          continue;
        }
        pending += `{${p.literal.length}${nonSync ? "+" : ""}}\r\n`;
        await this.writer.write(enc.encode(pending));
        pending = "";
        if (!nonSync) {
          const cont = await this.next();
          if (cont.kind !== "continuation") {
            throw new ImapError(`Server refused literal: ${cont.kind === "status" ? cont.text : "unexpected data"}`);
          }
        }
        await this.writer.write(p.literal);
      }
      await this.writer.write(enc.encode(`${pending}\r\n`));

      const data: DataResponse[] = [];
      for (;;) {
        const r = await this.next();
        if (r.kind === "continuation") continue; // only expected for literals, handled above
        if (r.kind === "data") {
          data.push(r);
          continue;
        }
        if (r.tag === "*") {
          if (r.status === "BYE" && parts[0] !== "LOGOUT") throw new ImapError(`IMAP server said BYE: ${r.text}`, r);
          this.takeCapabilityCode(r);
          continue;
        }
        if (r.tag !== tag) continue;
        this.takeCapabilityCode(r);
        if (r.status !== "OK" && !(opts.allowNo && r.status === "NO")) {
          const verb = typeof parts[0] === "string" ? parts[0].split(" ")[0] : "command";
          throw new ImapError(`IMAP ${verb} failed: ${r.status} ${r.code ? `[${r.code}] ` : ""}${r.text}`, r);
        }
        return { data, status: r };
      }
    };
    return withTimeout(run(), opts.timeoutMs ?? COMMAND_TIMEOUT_MS, `IMAP ${typeof parts[0] === "string" ? parts[0].split(" ")[0] : "command"}`);
  }

  /** SASL continuation exchange for AUTHENTICATE without SASL-IR. */
  async authenticate(mechanism: string, initialB64: string): Promise<void> {
    if (this.has("SASL-IR")) {
      await this.command([`AUTHENTICATE ${mechanism} ${initialB64}`]);
    } else {
      const tag = `A${++this.tagNo}`;
      await this.writer.write(enc.encode(`${tag} AUTHENTICATE ${mechanism}\r\n`));
      const cont = await withTimeout(this.next(), COMMAND_TIMEOUT_MS, "IMAP AUTHENTICATE");
      if (cont.kind !== "continuation") throw new ImapError("IMAP AUTHENTICATE was not accepted");
      await this.writer.write(enc.encode(`${initialB64}\r\n`));
      for (;;) {
        const r = await withTimeout(this.next(), COMMAND_TIMEOUT_MS, "IMAP AUTHENTICATE");
        if (r.kind === "continuation") {
          // XOAUTH2 sends an error JSON as a continuation; answer with an empty line to get the tagged NO.
          await this.writer.write(enc.encode("\r\n"));
          continue;
        }
        if (r.kind === "status" && r.tag === tag) {
          if (r.status !== "OK") throw new ImapError(`IMAP login failed: ${r.text}`, r);
          this.takeCapabilityCode(r);
          break;
        }
      }
    }
  }

  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command(["LOGOUT"], { timeoutMs: 3000 });
    } catch {
      // best effort
    }
    this.closed = true;
    try {
      await this.socket.close();
    } catch {
      // already closed
    }
  }
}
