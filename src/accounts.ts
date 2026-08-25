/**
 * Accounts store — multi-account credential management.
 *
 * Two sources are supported:
 *
 *   1. ACCOUNTS_JSON env var (preferred on Render — the filesystem is
 *      ephemeral across deploys/restarts, so there's nothing durable to
 *      watch). The whole accounts.json payload lives in one env var, set
 *      once in the Render dashboard. No hot-reload; changing it requires
 *      updating the env var and letting Render restart the service.
 *
 *   2. ACCOUNTS_FILE path (local dev / traditional VPS). Re-read via
 *      fs.watch whenever the file changes, no restart needed.
 *
 * File format (version 1):
 *   {
 *     "version": 1,
 *     "accounts": [
 *       {
 *         "id": "gmail",
 *         "label": "Gmail",
 *         "default": true,
 *         "imap": { "host": "...", "port": 993, "user": "...", "pass": "...", "tls": true },
 *         "smtp": { "host": "...", "port": 465, "user": "...", "pass": "...", "tls": true },
 *         "mail": { "defaultFrom": "...", "defaultFromName": "", "draftsFolder": "Drafts", "sentFolder": "Sent" }
 *       }
 *     ]
 *   }
 */

import { promises as fs } from "node:fs";
import { watch, FSWatcher } from "node:fs";
import path from "node:path";

export interface ImapCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface SmtpCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface MailDefaults {
  defaultFrom: string;
  defaultFromName?: string;
  draftsFolder: string;
  sentFolder: string | null;
}

export interface Account {
  id: string;
  label: string;
  default?: boolean;
  imap: ImapCreds;
  smtp: SmtpCreds;
  mail: MailDefaults;
}

export interface AccountsFile {
  version: 1;
  accounts: Account[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class AccountsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountsStoreError";
  }
}

export class NoSuchAccountError extends Error {
  constructor(public readonly accountId: string, availableIds: string[]) {
    super(
      availableIds.length === 0
        ? `No mailbox accounts configured. Set ACCOUNTS_JSON (or ACCOUNTS_FILE) with at least one account.`
        : `Account "${accountId}" is not configured. Available: ${availableIds.join(", ")}.`
    );
    this.name = "NoSuchAccountError";
  }
}

export class AccountsStore {
  private accounts: Account[] = [];
  private byId: Map<string, Account> = new Map();
  private watcher: FSWatcher | null = null;
  private readonly filePath: string | null;
  private readonly inlineJson: string | null;
  private onChange?: (next: Account[], prev: Account[]) => void;

  /**
   * @param filePath Path to accounts.json (file mode). Ignored if inlineJson is set.
   * @param inlineJson Raw accounts.json content from ACCOUNTS_JSON (env mode).
   */
  constructor(filePath: string | null, inlineJson: string | null) {
    this.filePath = filePath;
    this.inlineJson = inlineJson && inlineJson.trim() !== "" ? inlineJson : null;
  }

  async start(onChange?: (next: Account[], prev: Account[]) => void): Promise<void> {
    this.onChange = onChange;
    await this.reload();
    if (this.inlineJson) return; // static — nothing to watch
    if (!this.filePath) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    } catch {
      // Best-effort; reload would have already failed for permission issues.
    }
    this.watchFile();
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  async reload(): Promise<void> {
    const prev = this.accounts;

    if (this.inlineJson) {
      const parsed = parseAccountsFile(this.inlineJson);
      this.accounts = parsed.accounts;
      this.byId = new Map(parsed.accounts.map((a) => [a.id, a]));
      if (this.onChange) this.onChange(this.accounts, prev);
      return;
    }

    if (!this.filePath) {
      this.accounts = [];
      this.byId = new Map();
      return;
    }

    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.accounts = [];
        this.byId = new Map();
        if (this.onChange && prev.length > 0) {
          this.onChange(this.accounts, prev);
        }
        return;
      }
      throw err;
    }

    const parsed = parseAccountsFile(raw);
    this.accounts = parsed.accounts;
    this.byId = new Map(parsed.accounts.map((a) => [a.id, a]));
    if (this.onChange) {
      this.onChange(this.accounts, prev);
    }
  }

  list(): Account[] {
    return this.accounts;
  }

  ids(): string[] {
    return this.accounts.map((a) => a.id);
  }

  resolve(accountId?: string): Account {
    if (accountId) {
      const acc = this.byId.get(accountId);
      if (!acc) throw new NoSuchAccountError(accountId, this.ids());
      return acc;
    }
    const def = this.accounts.find((a) => a.default) ?? this.accounts[0];
    if (!def) throw new NoSuchAccountError("(default)", []);
    return def;
  }

  /**
   * Public summaries for the list_accounts MCP tool — never include
   * credentials in the response.
   */
  publicSummaries(): Array<{
    id: string;
    label: string;
    default: boolean;
    smtp_from: string;
    imap_host: string;
  }> {
    return this.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      default: Boolean(a.default),
      smtp_from: a.mail.defaultFrom,
      imap_host: a.imap.host,
    }));
  }

  private watchFile(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    let pending: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(dir, { persistent: false }, (_evt, filename) => {
        if (!filename || filename !== base) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          this.reload().catch((err) => {
            console.error(
              JSON.stringify({
                ts: new Date().toISOString(),
                level: "error",
                msg: "accounts.json reload failed",
                error: err instanceof Error ? err.message : String(err),
              })
            );
          });
        }, 150);
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "accounts.json watch failed; hot reload disabled",
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
}

function parseAccountsFile(raw: string): AccountsFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new AccountsStoreError(
      `accounts.json is not valid JSON: ${err instanceof Error ? err.message : err}`
    );
  }
  if (!json || typeof json !== "object") {
    throw new AccountsStoreError("accounts.json must be a JSON object");
  }
  const obj = json as { version?: unknown; accounts?: unknown };
  if (obj.version !== 1) {
    throw new AccountsStoreError(`Unsupported accounts.json version: ${obj.version}. Expected 1.`);
  }
  if (!Array.isArray(obj.accounts)) {
    throw new AccountsStoreError("accounts.json must have an `accounts` array");
  }
  const accounts: Account[] = obj.accounts.map((a, i) => parseAccount(a, i));
  const ids = new Set<string>();
  for (const a of accounts) {
    if (ids.has(a.id)) {
      throw new AccountsStoreError(`Duplicate account id: ${a.id}`);
    }
    ids.add(a.id);
  }
  return { version: 1, accounts };
}

function parseAccount(raw: unknown, index: number): Account {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`accounts[${index}] must be an object`);
  }
  const a = raw as Record<string, unknown>;
  const id = expectStr(a.id, `accounts[${index}].id`);
  if (!ID_PATTERN.test(id)) {
    throw new AccountsStoreError(
      `accounts[${index}].id must match ${ID_PATTERN} (a-z, 0-9, _, -; 1-32 chars; start alphanumeric)`
    );
  }
  return {
    id,
    label: expectStr(a.label, `accounts[${index}].label`),
    default: a.default === true ? true : undefined,
    imap: parseImap(a.imap, `accounts[${index}].imap`),
    smtp: parseSmtp(a.smtp, `accounts[${index}].smtp`),
    mail: parseMail(a.mail, `accounts[${index}].mail`),
  };
}

function parseImap(raw: unknown, where: string): ImapCreds {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  return {
    host: expectStr(o.host, `${where}.host`),
    port: expectInt(o.port, `${where}.port`),
    user: expectStr(o.user, `${where}.user`),
    pass: expectStr(o.pass, `${where}.pass`),
    tls: typeof o.tls === "boolean" ? o.tls : true,
  };
}

function parseSmtp(raw: unknown, where: string): SmtpCreds {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  return {
    host: expectStr(o.host, `${where}.host`),
    port: expectInt(o.port, `${where}.port`),
    user: expectStr(o.user, `${where}.user`),
    pass: expectStr(o.pass, `${where}.pass`),
    tls: typeof o.tls === "boolean" ? o.tls : true,
  };
}

function parseMail(raw: unknown, where: string): MailDefaults {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const sentRaw = o.sentFolder;
  const sentFolder =
    sentRaw === null || sentRaw === ""
      ? null
      : typeof sentRaw === "string"
        ? sentRaw
        : "Sent";
  return {
    defaultFrom: expectStr(o.defaultFrom, `${where}.defaultFrom`),
    defaultFromName: typeof o.defaultFromName === "string" ? o.defaultFromName : undefined,
    draftsFolder: typeof o.draftsFolder === "string" && o.draftsFolder.length > 0 ? o.draftsFolder : "Drafts",
    sentFolder,
  };
}

function expectStr(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new AccountsStoreError(`${where} must be a non-empty string`);
  }
  return v;
}

function expectInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new AccountsStoreError(`${where} must be an integer 1-65535`);
  }
  return v;
}
