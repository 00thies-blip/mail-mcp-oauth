#!/usr/bin/env node
/**
 * claude-mail-mcp (OAuth 2.1 fork) — entry point.
 *
 * One Express process, boots:
 *   - GET  /health                     liveness probe + accounts summary
 *   - GET  /.well-known/oauth-*        OAuth 2.1 discovery (see oauth.ts)
 *   - POST /register                   Dynamic Client Registration
 *   - GET/POST /authorize              login + PKCE code issuance
 *   - POST /token                      code/refresh -> access token
 *   - POST /mcp                        MCP Streamable HTTP transport (Bearer-gated)
 *
 * Unlike the upstream project's two-process VPS recipe (nginx + separate
 * OAuth shim + systemd), this fork runs everything in one process so it
 * fits a single Render web service with no persistent disk. See oauth.ts
 * for why that's safe (stateless JWTs, in-memory DCR/codes).
 */

import { setDefaultResultOrder } from "node:dns";
import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.js";
import { AccountsStore } from "./accounts.js";
import { ClientPool } from "./client-pool.js";
import { registerMailTools } from "./tools-mail.js";
import { buildOAuthRouter, verifyAccessToken } from "./oauth.js";
import { BrevoClient } from "./brevo-client.js";

const VERSION = "0.1.0";

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  };
  console.error(JSON.stringify(line));
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !verifyAccessToken(match[1])) {
    log("warn", "rejected unauthenticated MCP request", {
      ip: req.ip,
      path: req.path,
    });
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`
      )
      .json({
        error: "unauthorized",
        message: "Missing or invalid Bearer token",
      });
    return;
  }
  next();
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Robots-Tag", "noindex");
  next();
}

async function main(): Promise<void> {
  // Render's outbound network has no working IPv6 route, but plenty of
  // mail providers (Netcup among them) publish AAAA records. Node prefers
  // IPv6 by default when both exist, which surfaces as ENETUNREACH on
  // every IMAP/SMTP connection attempt. Prefer IPv4 results process-wide.
  setDefaultResultOrder("ipv4first");

  const store = new AccountsStore(
    config.accountsFile || null,
    config.accountsJson || null
  );
  const pool = new ClientPool(store);
  await store.start((next, prev) => {
    log("info", "accounts changed", {
      previous: prev.map((a) => a.id),
      current: next.map((a) => a.id),
    });
    pool.resetAll().catch((err) =>
      log("warn", "client pool reset failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  });
  log("info", "accounts loaded", {
    source: config.accountsJson ? "ACCOUNTS_JSON" : config.accountsFile || "(none)",
    count: store.list().length,
    ids: store.ids(),
  });

  const brevo = config.brevoApiKey ? new BrevoClient(config.brevoApiKey) : null;
  log("info", "send path", { mode: brevo ? "brevo-api" : "direct-smtp" });

  const mcp = new McpServer({
    name: "claude-mail-mcp",
    version: VERSION,
  });
  registerMailTools(mcp, pool, store, brevo);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(securityHeaders);

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "claude-mail-mcp",
      version: VERSION,
      accounts: store.publicSummaries(),
    });
  });

  app.use(buildOAuthRouter());

  app.post("/mcp", express.json({ limit: "5mb" }), bearerAuth, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error", "MCP request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `${req.method} ${req.path} is not a valid endpoint.`,
    });
  });

  app.listen(config.port, config.host, () => {
    log("info", "claude-mail-mcp listening", {
      host: config.host,
      port: config.port,
      version: VERSION,
      public_url: config.publicUrl,
      accounts: store.ids(),
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("info", "shutting down", { signal });
    store.stop();
    await pool.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
