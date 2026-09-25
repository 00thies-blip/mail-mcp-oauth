/**
 * mail-mcp -- Cloudflare Workers entry point (replaces the Render service).
 *
 *   GET  /health                      liveness + account count (no details)
 *   GET  /.well-known/oauth-*         OAuth discovery (oauth.ts)
 *   POST /register, GET /authorize, POST /token
 *   GET/POST /setup                   mailbox accounts (behind Cloudflare Access)
 *   POST /mcp                         MCP JSON-RPC, Bearer-gated
 */
import type { Env } from "./env.js";
import { loadAccounts } from "./store.js";
import { handleMcpMessage, SERVER_VERSION } from "./mcp.js";
import { routeOAuth, verifyAccessToken } from "./oauth.js";
import { TOOLS } from "./tools.js";
import { routeSetup } from "./setup.js";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function secure(resp: Response): Response {
  const h = new Headers(resp.headers);
  h.set("X-Frame-Options", "DENY");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Robots-Tag", "noindex");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

async function mcp(request: Request, env: Env): Promise<Response> {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m || !(await verifyAccessToken(env, m[1]!))) {
    return json({ error: "unauthorized", message: "Missing or invalid Bearer token" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${env.PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "parse_error", message: "Request body must be valid JSON" }, 400);
  }
  const result = await handleMcpMessage(body, TOOLS, env);
  return result === null ? new Response(null, { status: 202 }) : json(result);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let resp: Response;
    if (request.method === "GET" && url.pathname === "/health") {
      let accounts: number | string;
      try {
        accounts = (await loadAccounts(env)).length;
      } catch (e) {
        accounts = `invalid: ${e instanceof Error ? e.message : e}`;
      }
      resp = json({ status: "ok", server: "mail-mcp", version: SERVER_VERSION, accounts, login: env.ACCESS_AUD ? "cloudflare-access" : "not-configured" });
    } else if (url.pathname === "/mcp") {
      resp = request.method === "POST" ? await mcp(request, env) : json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    } else {
      resp = (await routeSetup(request, env)) ?? (await routeOAuth(request, env)) ?? json({ error: "not_found", message: `${request.method} ${url.pathname} is not a valid endpoint.` }, 404);
    }
    return secure(resp);
  },
};
