export interface Env {
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  /** Shared bearer token gating POST /mcp -- spike-only stand-in for OAuth. */
  SPIKE_TOKEN: string;
  /** Same accounts.json shape as the Render version's ACCOUNTS_JSON (see accounts.ts). */
  ACCOUNTS_JSON: string;
}
