/**
 * Environment configuration loader.
 *
 * Adapted for a single-process Render deployment: no nginx/systemd in
 * front, no separate OAuth shim process. This same process terminates
 * OAuth 2.1 (see oauth.ts) and serves the MCP endpoint.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsed;
}

export const config = {
  // Render assigns PORT dynamically and expects a bind on 0.0.0.0.
  port: int("PORT", 3220),
  host: optional("HOST", "0.0.0.0"),
  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",

  /**
   * Accounts can come from either a JSON blob in an env var (preferred on
   * Render — the filesystem is ephemeral) or a file path (useful for local
   * dev / traditional VPS deployments). ACCOUNTS_JSON wins if both are set.
   */
  accountsJson: optional("ACCOUNTS_JSON", ""),
  accountsFile: optional("ACCOUNTS_FILE", ""),

  publicUrl: optional("PUBLIC_URL", "http://localhost:3220"),

  // --- OAuth 2.1 (see oauth.ts) ---
  // Single-user login gate shown on the /authorize page. This is the
  // human login step Claude.ai's OAuth popup drives.
  oauthUser: required("OAUTH_USER"),
  oauthPass: required("OAUTH_PASS"),
  // Symmetric signing secret for issued access/refresh tokens (JWT HS256).
  // Generate with: openssl rand -hex 32
  jwtSecret: required("JWT_SECRET"),

  /**
   * Optional: Brevo API key for send_message. Render's free tier blocks
   * outbound SMTP ports entirely, so direct SMTP sending never connects
   * regardless of mail provider — set this to route sending over Brevo's
   * HTTPS API instead. Leave unset on hosts where raw SMTP egress works
   * (e.g. a VPS) to send directly as before. See docs/ACCOUNTS.md.
   */
  brevoApiKey: optional("BREVO_API_KEY", ""),
} as const;

export type Config = typeof config;
