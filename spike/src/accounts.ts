/**
 * Accounts parsing -- trimmed port of mail-mcp-oauth's src/accounts.ts for
 * the spike (read-only: imap + optional google, no smtp/mail defaults).
 *
 * Unlike the Render version this is pure: no fs, no file watching. A
 * Worker has no persistent filesystem and no state between requests, so
 * ACCOUNTS_JSON is parsed fresh (cheap: it's a handful of accounts) on
 * each request that needs it.
 */

export interface ImapCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
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
  imap: ImapCreds;
  google?: GoogleOAuthConfig;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class AccountsError extends Error {}

export function parseAccounts(raw: string): Account[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new AccountsError(`ACCOUNTS_JSON is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!json || typeof json !== "object") throw new AccountsError("ACCOUNTS_JSON must be a JSON object");
  const obj = json as { version?: unknown; accounts?: unknown };
  if (obj.version !== 1) throw new AccountsError(`Unsupported ACCOUNTS_JSON version: ${obj.version}. Expected 1.`);
  if (!Array.isArray(obj.accounts)) throw new AccountsError("ACCOUNTS_JSON must have an `accounts` array");

  const accounts = obj.accounts.map((a, i) => parseAccount(a, i));
  const ids = new Set<string>();
  for (const a of accounts) {
    if (ids.has(a.id)) throw new AccountsError(`Duplicate account id: ${a.id}`);
    ids.add(a.id);
  }
  return accounts;
}

export function resolveAccount(accounts: Account[], accountId?: string): Account {
  if (accountId) {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) {
      throw new AccountsError(`Account "${accountId}" is not configured. Available: ${accounts.map((a) => a.id).join(", ")}.`);
    }
    return acc;
  }
  const def = accounts.find((a) => a.default) ?? accounts[0];
  if (!def) throw new AccountsError("No mailbox accounts configured in ACCOUNTS_JSON.");
  return def;
}

function parseAccount(raw: unknown, index: number): Account {
  if (!raw || typeof raw !== "object") throw new AccountsError(`accounts[${index}] must be an object`);
  const a = raw as Record<string, unknown>;
  const id = expectStr(a.id, `accounts[${index}].id`);
  if (!ID_PATTERN.test(id)) {
    throw new AccountsError(`accounts[${index}].id must match ${ID_PATTERN}`);
  }
  const google = a.google ? parseGoogle(a.google, `accounts[${index}].google`) : undefined;
  return {
    id,
    label: expectStr(a.label, `accounts[${index}].label`),
    default: a.default === true ? true : undefined,
    imap: parseImap(a.imap, `accounts[${index}].imap`, Boolean(google)),
    google,
  };
}

function parseGoogle(raw: unknown, where: string): GoogleOAuthConfig {
  if (!raw || typeof raw !== "object") throw new AccountsError(`${where} must be an object`);
  const o = raw as Record<string, unknown>;
  return {
    clientId: expectStr(o.clientId, `${where}.clientId`),
    clientSecret: expectStr(o.clientSecret, `${where}.clientSecret`),
    refreshToken: expectStr(o.refreshToken, `${where}.refreshToken`),
  };
}

function parseImap(raw: unknown, where: string, allowEmptyPass: boolean): ImapCreds {
  if (!raw || typeof raw !== "object") throw new AccountsError(`${where} must be an object`);
  const o = raw as Record<string, unknown>;
  const passRaw = o.pass;
  if (typeof passRaw !== "string" || (passRaw === "" && !allowEmptyPass)) {
    throw new AccountsError(`${where}.pass must be a non-empty string`);
  }
  return {
    host: expectStr(o.host, `${where}.host`),
    port: expectInt(o.port, `${where}.port`),
    user: expectStr(o.user, `${where}.user`),
    pass: passRaw,
    tls: typeof o.tls === "boolean" ? o.tls : true,
  };
}

function expectStr(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) throw new AccountsError(`${where} must be a non-empty string`);
  return v;
}

function expectInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new AccountsError(`${where} must be an integer 1-65535`);
  }
  return v;
}
