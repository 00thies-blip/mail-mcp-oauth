/**
 * Mailbox accounts from the ACCOUNTS_JSON secret -- same schema as the Render
 * version (docs/ACCOUNTS.md), parsed per request (a Worker has no process to
 * cache it in, and parsing a few KB of JSON is negligible).
 *
 * Difference to the Render version: `smtp` and `mail` are optional. The Phase 0
 * spike stored a read-only variant without them; such an account can still be
 * read, and send/draft tools say exactly what is missing instead of crashing.
 */

export interface ServerCreds {
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

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface Account {
  id: string;
  label: string;
  default?: boolean;
  imap: ServerCreds;
  smtp: ServerCreds | null;
  mail: MailDefaults;
  google?: GoogleOAuthConfig;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class AccountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountsError";
  }
}

export function parseAccounts(raw: string | undefined): Account[] {
  if (!raw || raw.trim() === "") return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new AccountsError(`ACCOUNTS_JSON is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const obj = json as { version?: unknown; accounts?: unknown };
  if (!obj || typeof obj !== "object" || obj.version !== 1 || !Array.isArray(obj.accounts)) {
    throw new AccountsError("ACCOUNTS_JSON must be {\"version\":1,\"accounts\":[...]}");
  }
  const accounts = obj.accounts.map((a, i) => parseAccount(a, i));
  const seen = new Set<string>();
  for (const a of accounts) {
    if (seen.has(a.id)) throw new AccountsError(`Duplicate account id: ${a.id}`);
    seen.add(a.id);
  }
  return accounts;
}

export function resolveAccount(accounts: Account[], id?: string): Account {
  if (id) {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) {
      throw new AccountsError(
        accounts.length === 0
          ? "No mailbox accounts configured (ACCOUNTS_JSON is empty)."
          : `Account "${id}" is not configured. Available: ${accounts.map((a) => a.id).join(", ")}.`
      );
    }
    return acc;
  }
  const def = accounts.find((a) => a.default) ?? accounts[0];
  if (!def) throw new AccountsError("No mailbox accounts configured (ACCOUNTS_JSON is empty).");
  return def;
}

/** For list_accounts and /health -- never credentials. */
export function publicSummaries(accounts: Account[]) {
  return accounts.map((a) => ({
    id: a.id,
    label: a.label,
    default: Boolean(a.default),
    smtp_from: a.mail.defaultFrom,
    imap_host: a.imap.host,
    can_send: Boolean(a.google || a.smtp),
  }));
}

function parseAccount(raw: unknown, i: number): Account {
  const where = `accounts[${i}]`;
  if (!raw || typeof raw !== "object") throw new AccountsError(`${where} must be an object`);
  const a = raw as Record<string, unknown>;
  const id = str(a.id, `${where}.id`);
  if (!ID_PATTERN.test(id)) throw new AccountsError(`${where}.id must match ${ID_PATTERN}`);
  const google = a.google ? parseGoogle(a.google, `${where}.google`) : undefined;
  const imap = parseServer(a.imap, `${where}.imap`, Boolean(google));
  const smtp = a.smtp ? parseServer(a.smtp, `${where}.smtp`, Boolean(google)) : null;
  return {
    id,
    label: typeof a.label === "string" && a.label ? a.label : id,
    default: a.default === true ? true : undefined,
    imap,
    smtp,
    mail: parseMail(a.mail, imap.user),
    google,
  };
}

function parseGoogle(raw: unknown, where: string): GoogleOAuthConfig {
  if (!raw || typeof raw !== "object") throw new AccountsError(`${where} must be an object`);
  const o = raw as Record<string, unknown>;
  return {
    clientId: str(o.clientId, `${where}.clientId`),
    clientSecret: str(o.clientSecret, `${where}.clientSecret`),
    refreshToken: str(o.refreshToken, `${where}.refreshToken`),
  };
}

function parseServer(raw: unknown, where: string, allowEmptyPass: boolean): ServerCreds {
  if (!raw || typeof raw !== "object") throw new AccountsError(`${where} must be an object`);
  const o = raw as Record<string, unknown>;
  if (typeof o.pass !== "string" || (o.pass === "" && !allowEmptyPass)) {
    throw new AccountsError(`${where}.pass must be a non-empty string`);
  }
  const port = o.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AccountsError(`${where}.port must be an integer 1-65535`);
  }
  return {
    host: str(o.host, `${where}.host`),
    port,
    user: str(o.user, `${where}.user`),
    pass: o.pass,
    tls: typeof o.tls === "boolean" ? o.tls : true,
  };
}

function parseMail(raw: unknown, fallbackFrom: string): MailDefaults {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sent = o.sentFolder;
  return {
    defaultFrom: typeof o.defaultFrom === "string" && o.defaultFrom ? o.defaultFrom : fallbackFrom,
    defaultFromName: typeof o.defaultFromName === "string" && o.defaultFromName ? o.defaultFromName : undefined,
    draftsFolder: typeof o.draftsFolder === "string" && o.draftsFolder ? o.draftsFolder : "Drafts",
    sentFolder: sent === null || sent === "" ? null : typeof sent === "string" ? sent : "Sent",
  };
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) throw new AccountsError(`${where} must be a non-empty string`);
  return v;
}
