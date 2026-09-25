/**
 * Base64 / base64url helpers using only Web-standard APIs (`atob`/`btoa`,
 * `TextEncoder`/`TextDecoder`) — no `Buffer`, so this runs unchanged on
 * Cloudflare Workers (Workers has no Node `Buffer` global without the
 * `nodejs_compat` flag, and this project deliberately avoids that flag
 * so it stays on plain Workers semantics throughout).
 */

/** Standard base64, e.g. for the HTTP Basic Auth header. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function utf8ToBase64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

/** Decode standard base64 (with padding) to raw bytes. */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** base64url (RFC 4648 §5), no padding — used for the PKCE challenge. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time byte comparison — Workers has no `node:crypto.timingSafeEqual`. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  // Compare a fixed amount of work regardless of where the first
  // difference is, then fold in the length check last so an attacker
  // can't distinguish "wrong length" from "wrong content" by timing.
  const maxLen = Math.max(bufA.length, bufB.length, 1);
  let diff = bufA.length === bufB.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const byteA = i < bufA.length ? bufA[i]! : 0;
    const byteB = i < bufB.length ? bufB[i]! : 0;
    diff |= byteA ^ byteB;
  }
  return diff === 0;
}

/** SHA-256 → base64url, for PKCE's S256 code_challenge check. */
export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toBase64Url(new Uint8Array(digest));
}
