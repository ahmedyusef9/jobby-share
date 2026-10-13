import { accountForTenantStrict } from "@/lib/accounts";
import { currentAccount, can, CAP, denialReason } from "@/lib/entitlements";
import { consumeMcpCall, isMcpQuotaError, markMcpCallFailed } from "@/lib/mcp-quota";
import { resolveToken, touchToken } from "@/lib/mcp-tokens";
import { runWithTenant, tenantId } from "@/lib/tenant";
import { MCP_TOOLS, callMcpTool } from "@/lib/mcp/tools";
import { consumeToolBudget, toolBudgetState, validateAgainstSchema } from "@/lib/mcp/guards";
import {
  extractMcpKey,
  initializeResult,
  isJsonRpcNotification,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpc,
  toolTextResult,
  toolsListResult,
} from "@/lib/mcp-jsonrpc";
import { promptGetResult, promptsListResult } from "../../../../scripts/mcp-prompts.mjs";

// BL-066: the capability matrix owns both doors to a gated action — the
// browser path gates these in api/run/route.ts, this is the MCP door.
// Must be checked before consumeMcpCall (below) so a refusal doesn't spend
// the caller's daily quota.
const TOOL_CAPS: Record<string, string> = {
  resume_generate: CAP.GENERATE_CV,
};

export const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

export function mcpJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...MCP_CORS },
  });
}

export async function resolveMcpAccount(req: Request) {
  const key = extractMcpKey(req);
  if (!key) return { error: mcpJson({ error: "unauthorized — pass ?key=jb_… or Authorization: Bearer" }, 401) };
  const resolved = await resolveToken(key);
  if (!resolved) return { error: mcpJson({ error: "unauthorized" }, 401) };
  if (resolved.expired) {
    return { error: mcpJson({ error: "expired — mint a fresh key under Account → MCP" }, 401) };
  }
  const account = await accountForTenantStrict(resolved.tenantId);
  if (!account || (account.status && account.status !== "active")) {
    return { error: mcpJson({ error: "unauthorized" }, 401) };
  }
  void touchToken(resolved.id);
  return { tenantId: resolved.tenantId, account, scope: (resolved as { scope?: string }).scope || 'read-write' };
}

async function dispatch(
  msg: { id?: unknown; method?: string; params?: Record<string, unknown> },
  authed: boolean,
  ctxScope = 'read-write',
) {
  if (isJsonRpcNotification(msg)) return null;
  const id = msg.id ?? null;
  const method = String(msg.method || "");
  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (method === "initialize") return jsonRpcResult(id, initializeResult(params.protocolVersion));
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "prompts/list") return jsonRpcResult(id, promptsListResult());
  if (method === "prompts/get") {
    const name = String(params.name || "");
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<
      string,
      string
    >;
    const out = promptGetResult(name, args);
    if (out.error) return jsonRpcError(id, -32602, out.error);
    return jsonRpcResult(id, out);
  }
  if (method === "tools/list") return jsonRpcResult(id, toolsListResult([...MCP_TOOLS]));
  if (method === "tools/call") {
    if (!authed) {
      return jsonRpcError(id, -32001, "unauthorized — pass ?key=jb_… or /mcp/jb_…");
    }
    const name = String(params.name || "");
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<
      string,
      unknown
    >;
    // BL-075 scope gate: read-scope keys may not mutate anything.
    if (WRITE_TOOLS.has(name) && ctxScope === 'read') {
      return jsonRpcResult(
        id,
        toolTextResult(`this key is read-only — mint a read-write key under Account → MCP to use ${name}`, true),
      );
    }
    const toolDef = MCP_TOOLS.find((t) => t.name === name);
    if (!toolDef) {
      return jsonRpcResult(id, toolTextResult(`unknown tool: ${name}`, true));
    }
    // BL-072 guards: schema enforcement + per-tool daily budget, both before
    // any quota slot is consumed.
    const schemaError = validateAgainstSchema(args, toolDef.inputSchema);
    if (schemaError) return jsonRpcResult(id, toolTextResult(schemaError, true));
    const requiredCap = TOOL_CAPS[name];
    if (requiredCap) {
      const account = currentAccount();
      if (!can(account, requiredCap)) {
        // JSON-shaped, matching the {error: "..."} contract every in-tool
        // refusal uses (jsonText in mcp/tools.ts) — a bare string here parses
        // to {_raw: text} client-side, silently dropping .error (caught live
        // by test/web-e2e/mcp-tools.spec.mjs:65, not by manual curl).
        return jsonRpcResult(id, toolTextResult(JSON.stringify({ error: denialReason(account, requiredCap) }, null, 2), true));
      }
    }
    if (!consumeToolBudget(tenantId(), name)) {
      const state = toolBudgetState(tenantId(), name)!;
      return jsonRpcError(id, -32000, `daily budget for ${name} exhausted`, {
        code: "TOOL_BUDGET",
        used: state.used,
        limit: state.limit,
      });
    }
    let eventId: string | null = null;
    try {
      const slot = await consumeMcpCall(currentAccount(), tenantId());
      eventId = slot.eventId ?? null;
    } catch (err) {
      if (isMcpQuotaError(err)) {
        return jsonRpcError(id, -32000, (err as Error).message, {
          code: (err as { code?: string }).code,
          used: (err as { used?: number }).used,
          limit: (err as { limit?: number }).limit,
        });
      }
      throw err;
    }
    try {
      const result = await callMcpTool(name, args);
      return jsonRpcResult(id, result);
    } catch (err) {
      await markMcpCallFailed(eventId, err instanceof Error ? err.message : "tool");
      throw err;
    }
  }
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

async function respond(
  messages: { id?: unknown; method?: string; params?: Record<string, unknown> }[],
  authed: boolean,
  ctxScope = 'read-write',
) {
  if (messages.length === 1) {
    const out = await dispatch(messages[0], authed, ctxScope);
    if (out == null) return new Response(null, { status: 202, headers: MCP_CORS });
    return mcpJson(out);
  }
  const out = [];
  for (const msg of messages) {
    const one = await dispatch(msg, authed, ctxScope);
    if (one) out.push(one);
  }
  return mcpJson(out);
}

const WRITE_TOOLS = new Set([
  "update_resume",
  "resume_upload",
  "resume_update",
  "save_jobs",
  "add_application",
  "update_application",
  "update_job",
  "remove_application",
  "submit_score",
  "update_rules",
]);

export async function handleMcpJsonRpc(
  req: Request,
  ctx: { tenantId: string; account: unknown; scope?: string } | { public: true },
) {
  const ctxScope = "public" in ctx ? 'read-write' : ctx.scope || 'read-write';
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return mcpJson(jsonRpcError(null, -32700, "Parse error"), 400);
  }
  const parsed = parseJsonRpc(body);
  if (parsed.error) return mcpJson(parsed.error, 400);
  const messages = parsed.messages as { id?: unknown; method?: string; params?: Record<string, unknown> }[];

  if ("public" in ctx) {
    return respond(messages, false, 'read-write');
  }
  return runWithTenant({ tenantId: ctx.tenantId, account: ctx.account as never }, () =>
    respond(messages, true, ctxScope),
  );
}
