/**
 * mail-mcp-spike -- Phase 0 Go/No-Go spike (see spike/README.md).
 *
 * Only two tools, no OAuth 2.1 layer, no client pool: this exists purely
 * to answer "does imapflow work under Workers nodejs_compat, and what
 * does it cost in CPU-ms and bundle bytes" before committing to the full
 * Phase 1 port. Structure mirrors wordpress-mcp-cloudflare (Hono +
 * `@hono/mcp`'s StreamableHTTPTransport, stateless, one McpServer +
 * transport built fresh per request -- there is no persistent process to
 * hold a long-lived one in, unlike the Render version's index.ts).
 */
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import type { Env } from "./env.js";
import { parseAccounts, resolveAccount } from "./accounts.js";
import { getGoogleAccessToken } from "./google-oauth.js";
import { ImapClient } from "./imap-client.js";

const VERSION = "0.0.1-spike";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "mail-mcp-spike", version: VERSION });

  const accountSchema = z
    .string()
    .optional()
    .describe("Account ID from ACCOUNTS_JSON. Omit to use the default account.");

  server.registerTool(
    "list_folders",
    {
      description: "List all IMAP mailboxes (folders) on the configured account.",
      inputSchema: { account: accountSchema },
    },
    async ({ account }) => {
      const accounts = parseAccounts(env.ACCOUNTS_JSON);
      const acc = resolveAccount(accounts, account);
      const imap = new ImapClient({
        host: acc.imap.host,
        port: acc.imap.port,
        user: acc.imap.user,
        pass: acc.imap.pass,
        secure: acc.imap.tls,
        accessTokenProvider: acc.google && acc.imap.pass === "" ? () => getGoogleAccessToken(acc.google!) : undefined,
      });
      await imap.connect();
      try {
        const folders = await imap.listMailboxes();
        return { content: [{ type: "text" as const, text: JSON.stringify(folders, null, 2) }] };
      } finally {
        await imap.close();
      }
    }
  );

  server.registerTool(
    "list_messages",
    {
      description: "List the newest messages in a mailbox (newest first, default 5).",
      inputSchema: {
        mailbox: z.string().describe("IMAP folder path, e.g. 'INBOX'"),
        limit: z.number().int().min(1).max(50).optional().describe("Max messages to return (default 5)"),
        account: accountSchema,
      },
    },
    async ({ mailbox, limit, account }) => {
      const accounts = parseAccounts(env.ACCOUNTS_JSON);
      const acc = resolveAccount(accounts, account);
      const imap = new ImapClient({
        host: acc.imap.host,
        port: acc.imap.port,
        user: acc.imap.user,
        pass: acc.imap.pass,
        secure: acc.imap.tls,
        accessTokenProvider: acc.google && acc.imap.pass === "" ? () => getGoogleAccessToken(acc.google!) : undefined,
      });
      await imap.connect();
      try {
        const messages = await imap.listMessages(mailbox, limit ?? 5);
        return { content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }] };
      } finally {
        await imap.close();
      }
    }
  );

  return server;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok", server: "mail-mcp-spike", version: VERSION }));

app.all("/mcp", async (c) => {
  const authHeader = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const expected = c.env.SPIKE_TOKEN;
  if (!match || typeof expected !== "string" || expected.length === 0 || !timingSafeEqual(match[1], expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const server = buildMcpServer(c.env);
  // sessionIdGenerator unset -> stateless (no session, no initialize
  // handshake required -- see StreamableHTTPTransport#validateSession).
  // enableJsonResponse -> plain JSON body instead of SSE, matching the
  // Render version's transport config exactly.
  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c);
});

app.notFound((c) => c.json({ error: "not_found", message: `${c.req.method} ${c.req.path} is not a valid endpoint.` }, 404));

export default app;
