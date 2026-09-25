/** Cloudflare Workers bindings. */
export interface Env {
  PUBLIC_URL: string;
  LOG_LEVEL?: "debug" | "info" | "warn" | "error";

  /** Cloudflare Access protecting /authorize and /setup (see oauth.ts). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;

  JWT_SECRET: string;
  /** Fallback only -- accounts saved on /setup live encrypted in CONFIG. */
  ACCOUNTS_JSON?: string;
  CONFIG?: KVNamespace;
}
