import { createHash } from "node:crypto";
import { handleMcpJsonRpc, mcpJson, MCP_CORS, resolveMcpAccount } from "@/lib/mcp/handler";
import {
  MAX_BODY_BYTES,
  clearAuthFailures,
  isAuthLocked,
  recordAuthFailure,
} from "@/lib/mcp/guards";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "@/lib/mcp-jsonrpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HANDSHAKE = new Set(["initialize", "ping", "tools/list"]);

function handshakeMethod(body: unknown): string | null {
  const msg = Array.isArray(body) ? body[0] : body;
  const method = msg && typeof msg === "object" ? String((msg as { method?: string }).method || "") : "";
  if (HANDSHAKE.has(method) || method.startsWith("notifications/")) return method || "notifications";
  return null;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: MCP_CORS });
}

function sse() {
  return new Response(": connected\n\n", {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...MCP_CORS,
    },
  });
}

/**
 * GET — ChatGPT probes the origin with Accept: text/event-stream. Auth is not
 * required for this handshake; tools/call still needs the jb_ key.
 */
export async function GET(req: Request) {
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/event-stream")) return sse();
  return mcpJson({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    transport: "streamable-http",
    hint: "POST JSON-RPC (initialize, tools/list, tools/call). ChatGPT: use /mcp/jb_… with No authentication.",
  });
}

/**
 * Streamable-HTTP transport (BL-067): a client whose Accept includes
 * text/event-stream gets the single JSON-RPC message wrapped as an SSE
 * `message` event. ChatGPT's connector refuses bare application/json even
 * though the MCP spec allows both — so negotiate instead of assuming.
 */
async function maybeSse(req: Request, rpcResponse: Response): Promise<Response> {
  const accept = req.headers.get("accept") || "";
  if (!accept.includes("text/event-stream")) return rpcResponse;
  const payload = await rpcResponse.text();
  return new Response(`event: message\ndata: ${payload}\n\n`, {
    status: rpcResponse.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      ...MCP_CORS,
    },
  });
}

function keyFingerprint(req: Request): string | null {
  const url = new URL(req.url);
  const raw = url.searchParams.get("key") || "";
  if (!raw) {
    const auth = req.headers.get("authorization") || "";
    if (!auth.toLowerCase().startsWith("bearer ")) return null;
    return auth.slice(7).trim();
  }
  return raw;
}

export async function POST(req: Request) {
  // Payload cap — oversized bodies die here, never reach dispatch (BL-072).
  const raw = await req.clone().text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return mcpJson(
      { jsonrpc: "2.0", id: null, error: { code: -32602, message: "payload too large" } },
      413,
    );
  }

  const fingerprint = keyFingerprint(req);
  if (fingerprint && isAuthLocked(createHash("sha256").update(fingerprint).digest("hex").slice(0, 16))) {
    return mcpJson({ error: "key locked — too many failures, try again later" }, 429);
  }

  const resolved = await resolveMcpAccount(req);
  if (!resolved.error) {
    if (fingerprint) clearAuthFailures(createHash("sha256").update(fingerprint).digest("hex").slice(0, 16));
    return maybeSse(req, await handleMcpJsonRpc(req, {
      tenantId: resolved.tenantId,
      account: resolved.account,
      scope: resolved.scope,
    }));
  }
  if (fingerprint) recordAuthFailure(createHash("sha256").update(fingerprint).digest("hex").slice(0, 16));
  const peek = req.clone();
  let body: unknown;
  try {
    body = await peek.json();
  } catch {
    return resolved.error;
  }
  if (fingerprint || !handshakeMethod(body)) return resolved.error;
  return maybeSse(req, await handleMcpJsonRpc(req, { public: true }));
}

export function DELETE() {
  return new Response(null, { status: 204, headers: MCP_CORS });
}
