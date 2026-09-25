/**
 * Minimal MCP JSON-RPC dispatcher (Streamable HTTP, stateless, JSON responses)
 * -- the same slice as wordpress-mcp-cloudflare/src/mcp.ts: initialize, ping,
 * tools/list, tools/call, notifications. No SDK transport, no node:http.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Env } from "./env.js";
import type { ToolDef } from "./tools.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "mail-mcp";
export const SERVER_VERSION = "1.0.0";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

async function dispatch(req: JsonRpcRequest, tools: ToolDef[], env: Env): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize": {
      const asked = (req.params as { protocolVersion?: string } | undefined)?.protocolVersion;
      return ok(id, {
        protocolVersion: asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= PROTOCOL_VERSION ? asked : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" }),
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });
    case "tools/call": {
      const params = req.params as { name?: string; arguments?: unknown } | undefined;
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${String(params?.name)}`);
      const parsed = tool.inputSchema.safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify({ error: "invalid_arguments", detail: parsed.error.flatten() }, null, 2) }],
          isError: true,
        });
      }
      try {
        return ok(id, await tool.handler(parsed.data as Record<string, unknown>, env));
      } catch (err) {
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }],
          isError: true,
        });
      }
    }
    default:
      return req.id === undefined ? null : fail(id, -32601, `Method not found: ${req.method}`);
  }
}

/** Returns the JSON-RPC response body, or null when the request held only notifications (-> 202). */
export async function handleMcpMessage(body: unknown, tools: ToolDef[], env: Env): Promise<unknown | null> {
  const batch = Array.isArray(body);
  const out: JsonRpcResponse[] = [];
  for (const raw of batch ? (body as unknown[]) : [body]) {
    const req = raw as JsonRpcRequest;
    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      out.push(fail(null, -32600, "Invalid JSON-RPC request"));
      continue;
    }
    const r = await dispatch(req, tools, env);
    if (r) out.push(r);
  }
  if (out.length === 0) return null;
  return batch ? out : out[0];
}
