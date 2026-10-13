/**
 * MCP JSON-RPC 2.0 helpers. No transport, no tenant, no tools — those live
 * next to the HTTP handler so this file stays testable without Next.
 */
import { mcpInitializeInstructions } from './mcp-output-contract.mjs';

export const MCP_PROTOCOL = '2024-11-05';
export const MCP_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
export const MCP_SERVER_NAME = 'Jobby';
export const MCP_SERVER_VERSION = '0.4.9';

export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

export function isJsonRpcNotification(msg) {
  return Boolean(msg) && msg.jsonrpc === '2.0' && typeof msg.method === 'string' && msg.id === undefined;
}

export function parseJsonRpc(body) {
  if (body == null) return { error: jsonRpcError(null, -32700, 'Parse error') };
  const messages = Array.isArray(body) ? body : [body];
  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== '2.0' || (typeof msg.method !== 'string' && msg.id === undefined && !msg.error && !msg.result)) {
      return { error: jsonRpcError(msg?.id ?? null, -32600, 'Invalid Request') };
    }
  }
  return { messages };
}

export function initializeResult(requested) {
  const want = String(requested || '').trim();
  const protocolVersion = MCP_PROTOCOLS.includes(want) ? want : MCP_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    instructions: mcpInitializeInstructions(),
  };
}

/**
 * @param {{ name: string, description: string, inputSchema: object }[]} tools
 */
export function toolsListResult(tools) {
  return { tools };
}

export function toolTextResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text ?? '') }],
    ...(isError ? { isError: true } : {}),
  };
}

export function extractMcpKey(req) {
  if (!req) return '';
  const header = String(req.headers?.get?.('authorization') || '');
  const bearer = header.match(/^Bearer\s+(\S+)/i);
  if (bearer) return bearer[1].trim();
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('key') || url.searchParams.get('api_key') || '').trim();
    if (q) return q;
    const path = url.pathname.match(/\/(?:api\/)?mcp\/(jb_[A-Za-z0-9_]+)$/i);
    return path ? path[1] : '';
  } catch {
    return '';
  }
}
