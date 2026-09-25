/**
 * OAuth 2.1 authorization server for Claude.ai -- stateless, ported from
 * wordpress-mcp-cloudflare/src/oauth.ts (DCR client_id = signed JWT, code =
 * short-lived signed JWT, access/refresh tokens = JWTs, PKCE S256 mandatory).
 *
 * The one change: there is no username/password form. GET /authorize sits
 * behind Cloudflare Access (application "Mail MCP – Anmeldung", path
 * /authorize only, e-mail code to OWNER_EMAIL). The Worker verifies the Access
 * JWT itself -- signature against the team's JWKS, audience, and that the
 * e-mail is OWNER_EMAIL -- before it issues a code. /register, /token and /mcp
 * stay outside Access because Claude.ai calls them server-to-server.
 */
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env.js";
import { randomHex, sha256Base64Url, timingSafeEqualStr } from "./base64.js";

const AUTH_CODE_TTL_SECONDS = 120;
const ACCESS_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const SUBJECT = "lukasthies";

const key = (env: Env) => new TextEncoder().encode(env.JWT_SECRET);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// ------------------------------------------------------------ Cloudflare Access

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTeam = "";

/** E-mail of the Access-authenticated user, or null. */
export async function accessUser(request: Request, env: Env): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  if (!jwks || jwksTeam !== env.ACCESS_TEAM_DOMAIN) {
    jwks = createRemoteJWKSet(new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    jwksTeam = env.ACCESS_TEAM_DOMAIN;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${env.ACCESS_TEAM_DOMAIN}`, audience: env.ACCESS_AUD });
    const email = String(payload.email ?? "").toLowerCase();
    return email && email === (env.OWNER_EMAIL ?? "").toLowerCase() ? email : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ clients and codes

interface ClientClaims extends JWTPayload {
  purpose: "client";
  redirect_uris: string[];
  client_name: string;
}

interface CodeClaims extends JWTPayload {
  purpose: "code";
  jti: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
}

async function verifyClient(env: Env, clientId: string): Promise<ClientClaims | null> {
  try {
    const { payload } = await jwtVerify<ClientClaims>(clientId, key(env));
    return payload.purpose === "client" && Array.isArray(payload.redirect_uris) ? payload : null;
  } catch {
    return null;
  }
}

// Fast path for single use within one isolate; the KV marker in token() covers the rest.
const redeemed = new Map<string, number>();

async function issueTokens(env: Env, clientId: string, scope: string) {
  const sign = (type: string, ttl: number) =>
    new SignJWT({ sub: SUBJECT, type, client_id: clientId, scope }).setProtectedHeader({ alg: "HS256" }).setExpirationTime(`${ttl}s`).sign(key(env));
  return {
    access_token: await sign("access", ACCESS_TOKEN_TTL_SECONDS),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: await sign("refresh", REFRESH_TOKEN_TTL_SECONDS),
    scope,
  };
}

export async function verifyAccessToken(env: Env, token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify<{ type?: string }>(token, key(env));
    return payload.type === "access";
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ routes

async function register(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (uris.length === 0 || !uris.every((u) => typeof u === "string")) {
    return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be a non-empty array of strings" }, 400);
  }
  for (const u of uris as string[]) {
    let p: URL;
    try {
      p = new URL(u);
    } catch {
      return json({ error: "invalid_redirect_uri", error_description: `${u} is not a valid URL` }, 400);
    }
    if (p.protocol !== "https:" && !(p.protocol === "http:" && p.hostname === "localhost")) {
      return json({ error: "invalid_redirect_uri", error_description: `${u} must be https://` }, 400);
    }
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : "MCP client";
  const clientId = await new SignJWT({ purpose: "client", redirect_uris: uris, client_name: name }).setProtectedHeader({ alg: "HS256" }).sign(key(env));
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: name,
    },
    201
  );
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");
  const challenge = q.get("code_challenge");
  if (q.get("response_type") !== "code") return text("Unsupported response_type. Only 'code' is supported.", 400);
  if (!clientId || !redirectUri) return text("Missing client_id or redirect_uri.", 400);
  const client = await verifyClient(env, clientId);
  if (!client || !client.redirect_uris.includes(redirectUri)) return text("Unknown client_id or redirect_uri not registered for this client.", 400);
  if (q.get("code_challenge_method") !== "S256" || !challenge || challenge.length < 43) return text("PKCE with code_challenge_method=S256 is required.", 400);

  if (!env.ACCESS_AUD) return text("Login is not configured yet (Cloudflare Access application missing).", 503);
  const user = await accessUser(request, env);
  if (!user) return text("Not signed in via Cloudflare Access as the owner of this connector.", 403);

  const code = await new SignJWT({
    purpose: "code",
    jti: randomHex(12),
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    scope: q.get("scope") ?? "mcp",
  } satisfies Omit<CodeClaims, "exp">)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${AUTH_CODE_TTL_SECONDS}s`)
    .sign(key(env));
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  const state = q.get("state");
  if (state) target.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
}

async function token(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get("content-type") ?? "";
  const body: Record<string, unknown> = ct.includes("application/json")
    ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
    : Object.fromEntries((await request.formData()).entries());

  if (body.grant_type === "authorization_code") {
    if (typeof body.code !== "string") return json({ error: "invalid_request" }, 400);
    let c: CodeClaims;
    try {
      c = (await jwtVerify<CodeClaims>(body.code, key(env))).payload;
      if (c.purpose !== "code") throw new Error("purpose");
    } catch {
      return json({ error: "invalid_grant", error_description: "Unknown or expired code" }, 400);
    }
    const now = Date.now();
    for (const [j, exp] of redeemed) if (exp < now) redeemed.delete(j);
    // Single use across isolates via KV (the in-memory map only covers this isolate).
    const used = redeemed.has(c.jti) || (env.CONFIG ? (await env.CONFIG.get(`code:${c.jti}`)) !== null : false);
    if (used) return json({ error: "invalid_grant", error_description: "Authorization code already used" }, 400);
    redeemed.set(c.jti, now + AUTH_CODE_TTL_SECONDS * 1000);
    await env.CONFIG?.put(`code:${c.jti}`, "1", { expirationTtl: AUTH_CODE_TTL_SECONDS + 60 });
    if (c.client_id !== body.client_id || c.redirect_uri !== body.redirect_uri) {
      return json({ error: "invalid_grant", error_description: "client_id/redirect_uri mismatch" }, 400);
    }
    const verifier = body.code_verifier;
    if (typeof verifier !== "string" || !timingSafeEqualStr(await sha256Base64Url(verifier), c.code_challenge)) {
      return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
    return json(await issueTokens(env, c.client_id, c.scope));
  }

  if (body.grant_type === "refresh_token") {
    if (typeof body.refresh_token !== "string") return json({ error: "invalid_request" }, 400);
    try {
      const { payload } = await jwtVerify<{ type: string; client_id: string; scope: string }>(body.refresh_token, key(env));
      if (payload.type !== "refresh") throw new Error("type");
      if (body.client_id && payload.client_id !== body.client_id) throw new Error("client");
      return json(await issueTokens(env, payload.client_id, payload.scope));
    } catch {
      return json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" }, 400);
    }
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

export async function routeOAuth(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const m = request.method;
  if (m === "GET" && pathname === "/.well-known/oauth-authorization-server") {
    const i = env.PUBLIC_URL;
    return json({
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      registration_endpoint: `${i}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  }
  if (m === "GET" && pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return json({ resource: `${env.PUBLIC_URL}/mcp`, authorization_servers: [env.PUBLIC_URL] });
  }
  if (m === "POST" && pathname === "/register") return register(request, env);
  if (m === "GET" && pathname === "/authorize") return authorize(request, env);
  if (m === "POST" && pathname === "/token") return token(request, env);
  return null;
}
