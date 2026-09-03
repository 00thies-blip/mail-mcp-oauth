/**
 * OAuth 2.1 authorization server, folded into the same process as the MCP
 * backend (no separate shim service — Render runs one web service on one
 * port, and everything here is stateless so it survives redeploys/restarts
 * without a database):
 *
 *   - GET  /.well-known/oauth-authorization-server   (RFC 8414)
 *   - GET  /.well-known/oauth-protected-resource      (RFC 9728)
 *   - POST /register                                   Dynamic Client Registration (RFC 7591)
 *   - GET  /authorize + POST /authorize                 Login + consent (single hard-coded user)
 *   - POST /token                                       authorization_code + refresh_token grants
 *
 * Design choices driven by "no persistent disk on Render":
 *   - Access + refresh tokens are self-contained JWTs (HS256, JWT_SECRET).
 *     No token store needed; validation is pure signature + expiry check.
 *   - Registered OAuth clients (from DCR) and in-flight authorization codes
 *     live in memory only. A restart forces Claude.ai to re-register and
 *     re-authorize, which its MCP client handles automatically on 401.
 *   - The GET /authorize request is round-tripped through the login form as
 *     a signed JWT "ticket" instead of a server-side session, so there's no
 *     session store either.
 *
 * PKCE (S256) is mandatory — this server never issues a code without it,
 * consistent with OAuth 2.1's removal of the plain method and of the
 * implicit grant.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import express, { Request, Response, Router } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

const AUTH_CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes
// A short access token forced Claude.ai to redo the full browser
// /authorize login on every expiry instead of silently using the refresh
// token — for a personal single-user connector where the login itself
// gates nothing more than this same JWT_SECRET already does, that's pure
// friction with no real security upside. Set to effectively "never
// expires" (10 years) so the user is never asked to log back in once
// connected. Revocation is "rotate JWT_SECRET", which invalidates every
// outstanding token at once.
const ACCESS_TOKEN_TTL = "3650d";
const REFRESH_TOKEN_TTL = "3650d";
const TICKET_TTL = "10m";
const SUBJECT = "lukasthies";

// Some OAuth clients sanity-check or clamp an implausibly large
// `expires_in` (10 years ≈ 3.15e8 s). Report one year — the access token
// JWT still carries the real 10-year `exp`, this just tells Claude.ai to
// run its silent background refresh sometime within the year instead of
// treating the value as bogus.
const ACCESS_TOKEN_EXPIRES_IN = 365 * 24 * 60 * 60;

// Persistent "stay signed in" browser session. Render's free tier sleeps
// the service after 15 min idle and cold-starts it on the next hit;
// Claude.ai also re-validates the connector on its own schedule. Either
// way it re-runs the browser /authorize flow. Without a session this
// means retyping the login every single day. This signed, HttpOnly,
// Secure cookie is set once on a successful login and then lets every
// later /authorize complete silently (popup opens and closes itself).
// Same 10-year horizon and same revocation story as the tokens: rotate
// JWT_SECRET to invalidate everything at once.
const SESSION_COOKIE = "mcp_session";
const SESSION_TTL = "3650d";
const SESSION_TTL_MS = 3650 * 24 * 60 * 60 * 1000;

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  createdAt: number;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

// --- in-memory state -------------------------------------------------

const clients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthCode>();

function pruneExpiredCodes(): void {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
}

// crude per-IP login throttle — 10 failed attempts / 15 min
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function isLockedOut(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// --- helpers -----------------------------------------------------------

function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = base64url(createHash("sha256").update(verifier).digest());
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// --- stateless OAuth client registry ---------------------------------
//
// Render's free tier has no persistent disk and cold-starts the process
// on the first request after it goes idle, wiping the in-memory `clients`
// map. If client registrations only lived there, every cold start forced
// Claude.ai to re-register AND re-run the full browser login. Instead the
// client_id issued by /register is itself a signed JWT carrying the
// registration, so it verifies after any restart with no state. The
// in-memory map is kept only as a fast path / for nicer logs.

interface ClientClaims {
  t: "client";
  ru: string[];
  cn: string;
}

function makeClientId(redirectUris: string[], clientName: string): string {
  // No expiry — a DCR registration is meant to be durable.
  return jwt.sign(
    { t: "client", ru: redirectUris, cn: clientName } satisfies ClientClaims,
    config.jwtSecret
  );
}

function resolveClient(
  clientId: string
): { redirectUris: string[]; clientName: string } | null {
  const mem = clients.get(clientId);
  if (mem) return { redirectUris: mem.redirectUris, clientName: mem.clientName };
  try {
    const c = jwt.verify(clientId, config.jwtSecret) as Partial<ClientClaims>;
    if (c.t !== "client" || !Array.isArray(c.ru) || c.ru.length === 0) return null;
    if (!c.ru.every((u) => typeof u === "string")) return null;
    return { redirectUris: c.ru, clientName: typeof c.cn === "string" ? c.cn : "MCP client" };
  } catch {
    return null;
  }
}

// --- persistent browser session ("stay signed in") ------------------

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function hasValidSession(req: Request): boolean {
  const token = parseCookies(req.header("cookie"))[SESSION_COOKIE];
  if (!token) return false;
  try {
    const claims = jwt.verify(token, config.jwtSecret) as { purpose?: string };
    return claims.purpose === "session";
  } catch {
    return false;
  }
}

function setSessionCookie(res: Response): void {
  const token = jwt.sign(
    { purpose: "session", sub: SUBJECT },
    config.jwtSecret,
    { expiresIn: SESSION_TTL }
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

/** Mint + store a single-use auth code and return the 302 target. */
function issueAuthCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string;
}): string {
  pruneExpiredCodes();
  const code = randomId(24);
  authCodes.set(code, {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    scope: params.scope,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return redirect.toString();
}

function html(strings: TemplateStringsArray, ...values: string[]): string {
  return strings.reduce((acc, s, i) => acc + s + (values[i] ?? ""), "");
}

function loginPage(opts: { ticket: string; error?: string }): string {
  const errorBlock = opts.error
    ? `<p class="error">${opts.error}</p>`
    : "";
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Mail MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1115; color: #e6e6e6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  form { background: #1a1d24; padding: 2rem 2.5rem; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.4); width: 100%; max-width: 340px; }
  h1 { font-size: 1.1rem; margin: 0 0 1.25rem; font-weight: 600; }
  label { display: block; font-size: .8rem; margin-bottom: .3rem; color: #9aa0aa; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; border: 1px solid #33363f; background: #0f1115; color: #e6e6e6; font-size: .95rem; }
  button { width: 100%; padding: .65rem; border-radius: 6px; border: none; background: #4f7cff; color: white; font-weight: 600; font-size: .95rem; cursor: pointer; }
  button:hover { background: #3f68e0; }
  .error { color: #ff6b6b; font-size: .85rem; margin: -.5rem 0 1rem; }
</style>
</head>
<body>
  <form method="POST" action="/authorize">
    <h1>Sign in to connect Mail MCP</h1>
    ${errorBlock}
    <input type="hidden" name="ticket" value="${opts.ticket}">
    <label for="username">Username</label>
    <input type="text" id="username" name="username" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

// --- router --------------------------------------------------------------

export function buildOAuthRouter(): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const issuer = config.publicUrl;
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const issuer = config.publicUrl;
    res.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
    });
  });

  router.post("/register", express.json(), (req, res) => {
    const body = req.body ?? {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.length === 0 || !redirectUris.every((u: unknown) => typeof u === "string")) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris must be a non-empty array of strings" });
      return;
    }
    for (const uri of redirectUris) {
      try {
        const parsed = new URL(uri);
        if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) {
          res.status(400).json({ error: "invalid_redirect_uri", error_description: `${uri} must be https:// (or http://localhost for local testing)` });
          return;
        }
      } catch {
        res.status(400).json({ error: "invalid_redirect_uri", error_description: `${uri} is not a valid URL` });
        return;
      }
    }

    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : "MCP client";
    // Signed, self-describing client_id — verifies after any cold start
    // without a lookup, so Claude.ai never has to re-register.
    const clientId = makeClientId(redirectUris, clientName);
    clients.set(clientId, {
      clientId,
      redirectUris,
      clientName,
      createdAt: Date.now(),
    });
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "client registered via DCR",
        client_id: clientId,
        redirect_uris: redirectUris,
        client_name: clientName,
      })
    );

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: clientName,
    });
  });

  router.get("/authorize", (req: Request, res: Response) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      scope,
    } = req.query;

    if (response_type !== "code") {
      res.status(400).send("Unsupported response_type. Only 'code' is supported.");
      return;
    }
    if (typeof client_id !== "string" || typeof redirect_uri !== "string") {
      res.status(400).send("Missing client_id or redirect_uri.");
      return;
    }
    const client = resolveClient(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "authorize rejected: client_id/redirect_uri mismatch",
          received_client_id: client_id,
          received_redirect_uri: redirect_uri,
          client_found: Boolean(client),
          client_registered_redirect_uris: client?.redirectUris ?? null,
        })
      );
      res.status(400).send("Unknown client_id or redirect_uri not registered for this client.");
      return;
    }
    if (code_challenge_method !== "S256" || typeof code_challenge !== "string" || code_challenge.length < 43) {
      res.status(400).send("PKCE with code_challenge_method=S256 is required.");
      return;
    }

    const scopeStr = typeof scope === "string" ? scope : "mcp";
    const stateStr = typeof state === "string" ? state : "";

    // Already signed in on this browser? Complete the flow silently — no
    // login page. This is what stops the daily re-login: Claude.ai
    // re-runs /authorize on its own schedule and after every Render cold
    // start, and without this each one is a manual prompt.
    if (hasValidSession(req)) {
      setSessionCookie(res); // slide the 10-year window forward
      const target = issueAuthCode({
        clientId: client_id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        scope: scopeStr,
        state: stateStr,
      });
      res.redirect(302, target);
      return;
    }

    const ticket = jwt.sign(
      {
        purpose: "authorize",
        client_id,
        redirect_uri,
        state: stateStr,
        code_challenge,
        scope: scopeStr,
      },
      config.jwtSecret,
      { expiresIn: TICKET_TTL }
    );

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(loginPage({ ticket }));
  });

  router.post("/authorize", (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";
    const { ticket, username, password } = req.body ?? {};

    if (typeof ticket !== "string") {
      res.status(400).send("Missing or expired login session. Please retry the connection from Claude.");
      return;
    }

    let claims: {
      purpose: string;
      client_id: string;
      redirect_uri: string;
      state: string;
      code_challenge: string;
      scope: string;
    };
    try {
      claims = jwt.verify(ticket, config.jwtSecret) as typeof claims;
      if (claims.purpose !== "authorize") throw new Error("wrong purpose");
    } catch {
      res.status(400).send("This login link expired. Please retry the connection from Claude.");
      return;
    }

    if (isLockedOut(ip)) {
      res.status(429).send("Too many failed login attempts. Try again in a few minutes.");
      return;
    }

    const validUser = typeof username === "string" && safeEqual(username, config.oauthUser);
    const validPass = typeof password === "string" && safeEqual(password, config.oauthPass);
    if (!validUser || !validPass) {
      recordFailedLogin(ip);
      res.set("Content-Type", "text/html; charset=utf-8");
      res.status(401).send(loginPage({ ticket, error: "Invalid username or password." }));
      return;
    }
    clearLoginAttempts(ip);

    // Remember this browser so future /authorize round-trips (Claude.ai
    // re-validation, Render cold starts) complete without a login prompt.
    setSessionCookie(res);

    const target = issueAuthCode({
      clientId: claims.client_id,
      redirectUri: claims.redirect_uri,
      codeChallenge: claims.code_challenge,
      scope: claims.scope,
      state: claims.state,
    });
    res.redirect(302, target);
  });

  router.post("/token", (req: Request, res: Response) => {
    const grantType = req.body?.grant_type;

    if (grantType === "authorization_code") {
      const { code, redirect_uri, client_id, code_verifier } = req.body ?? {};
      if (typeof code !== "string") {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      pruneExpiredCodes();
      const entry = authCodes.get(code);
      if (!entry || entry.expiresAt < Date.now()) {
        res.status(400).json({ error: "invalid_grant", error_description: "Unknown or expired code" });
        return;
      }
      authCodes.delete(code); // single use, regardless of outcome below

      if (entry.clientId !== client_id || entry.redirectUri !== redirect_uri) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id/redirect_uri mismatch" });
        return;
      }
      if (typeof code_verifier !== "string" || !verifyPkce(code_verifier, entry.codeChallenge)) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }

      const tokens = issueTokens(entry.clientId, entry.scope);
      res.json(tokens);
      return;
    }

    if (grantType === "refresh_token") {
      const { refresh_token, client_id } = req.body ?? {};
      if (typeof refresh_token !== "string") {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      let claims: { sub: string; type: string; client_id: string; scope: string };
      try {
        claims = jwt.verify(refresh_token, config.jwtSecret) as typeof claims;
        if (claims.type !== "refresh") throw new Error("wrong type");
        if (client_id && claims.client_id !== client_id) throw new Error("client mismatch");
      } catch {
        res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" });
        return;
      }
      const tokens = issueTokens(claims.client_id, claims.scope);
      res.json(tokens);
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  return router;
}

function issueTokens(clientId: string, scope: string) {
  const accessToken = jwt.sign(
    { sub: SUBJECT, type: "access", client_id: clientId, scope },
    config.jwtSecret,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
  const refreshToken = jwt.sign(
    { sub: SUBJECT, type: "refresh", client_id: clientId, scope },
    config.jwtSecret,
    { expiresIn: REFRESH_TOKEN_TTL }
  );
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_EXPIRES_IN,
    refresh_token: refreshToken,
    scope,
  };
}

/** Verify a bearer access token from the Authorization header. */
export function verifyAccessToken(token: string): boolean {
  try {
    const claims = jwt.verify(token, config.jwtSecret) as { type?: string };
    return claims.type === "access";
  } catch {
    return false;
  }
}
