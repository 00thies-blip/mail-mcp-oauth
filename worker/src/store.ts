/**
 * Accounts entered on /setup, stored in KV encrypted with AES-GCM. The key is
 * derived from JWT_SECRET, so KV alone (e.g. a leaked backup) reveals nothing,
 * and rotating JWT_SECRET means re-entering the accounts once.
 */
import { fromBase64, toBase64 } from "./base64.js";
import { parseAccounts, type Account } from "./accounts.js";
import type { Env } from "./env.js";

const KV_KEY = "accounts.v1";

async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`accounts:${env.JWT_SECRET}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function saveAccountsJson(env: Env, json: string): Promise<void> {
  if (!env.CONFIG) throw new Error("KV binding CONFIG missing");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(json));
  await env.CONFIG.put(KV_KEY, JSON.stringify({ iv: toBase64(iv), data: toBase64(new Uint8Array(data)), savedAt: new Date().toISOString() }));
}

export async function loadAccountsJson(env: Env): Promise<{ json: string | undefined; source: "setup" | "secret" | "none"; savedAt?: string }> {
  const stored = env.CONFIG ? await env.CONFIG.get(KV_KEY) : null;
  if (stored) {
    const s = JSON.parse(stored) as { iv: string; data: string; savedAt: string };
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(s.iv) }, await aesKey(env), fromBase64(s.data));
    return { json: new TextDecoder().decode(plain), source: "setup", savedAt: s.savedAt };
  }
  if (env.ACCOUNTS_JSON?.trim()) return { json: env.ACCOUNTS_JSON, source: "secret" };
  return { json: undefined, source: "none" };
}

export async function loadAccounts(env: Env): Promise<Account[]> {
  return parseAccounts((await loadAccountsJson(env)).json);
}
