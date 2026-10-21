/**
 * Pure edits of the stored accounts JSON (kept free of I/O so they can be unit-tested).
 * - appendAccount: adds or replaces one mailbox and keeps every other one, whatever the
 *   current source (KV or the ACCOUNTS_JSON secret). Before 21.10.2026 an add on top of the
 *   secret started from an empty list and silently dropped the other mailboxes.
 * - withoutAccount: removes one mailbox; refuses the default mailbox, an unknown id and the
 *   last mailbox, so a mistaken click can never leave the connector without accounts.
 */
type RawAccount = Record<string, unknown> & { id?: unknown; default?: unknown };

function list(json: string | undefined): RawAccount[] {
  if (!json || json.trim() === "") return [];
  const obj = JSON.parse(json) as { accounts?: unknown };
  return Array.isArray(obj.accounts) ? (obj.accounts as RawAccount[]) : [];
}

export function appendAccount(json: string | undefined, entry: RawAccount): string {
  const rest = list(json).filter((a) => a.id !== entry.id);
  return JSON.stringify({ version: 1, accounts: [...rest, entry] });
}

export function withoutAccount(json: string | undefined, id: string): string {
  const all = list(json);
  const target = all.find((a) => a.id === id);
  if (!target) throw new Error(`Postfach „${id}“ ist nicht gespeichert.`);
  if (target.default) throw new Error(`„${id}“ ist das Standard-Postfach und wird nicht entfernt.`);
  const rest = all.filter((a) => a.id !== id);
  if (rest.length === 0) throw new Error("Das letzte Postfach wird nicht entfernt.");
  return JSON.stringify({ version: 1, accounts: rest });
}
