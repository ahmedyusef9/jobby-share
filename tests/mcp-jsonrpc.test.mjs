import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MCP_PROTOCOL,
  extractMcpKey,
  initializeResult,
  isJsonRpcNotification,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpc,
  toolTextResult,
  toolsListResult,
} from '../scripts/mcp-jsonrpc.mjs';

test('initialize names Jobby and advertises tools', () => {
  const r = initializeResult();
  assert.equal(r.protocolVersion, MCP_PROTOCOL);
  assert.equal(r.serverInfo.name, 'Jobby');
  assert.match(r.instructions, /table/);
  assert.ok(r.capabilities.tools);
  assert.equal(initializeResult('2025-06-18').protocolVersion, '2025-06-18');
});

test('parseJsonRpc accepts a single request and a batch', () => {
  const one = parseJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(one.messages.length, 1);
  const batch = parseJsonRpc([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ]);
  assert.equal(batch.messages.length, 2);
});

test('notifications have no id and produce no response body', () => {
  assert.equal(isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }), true);
  assert.equal(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'ping' }), false);
});

test('tool results are MCP content blocks', () => {
  const ok = toolTextResult('hello');
  assert.deepEqual(ok.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(ok.isError, undefined);
  const bad = toolTextResult('nope', true);
  assert.equal(bad.isError, true);
});

test('tools/list shape is what Cursor and Claude expect', () => {
  const listed = toolsListResult([
    { name: 'whoami', description: 'id', inputSchema: { type: 'object', properties: {} } },
  ]);
  assert.equal(listed.tools[0].name, 'whoami');
  assert.equal(jsonRpcResult(1, listed).jsonrpc, '2.0');
  assert.equal(jsonRpcError(1, -32601, 'missing').error.code, -32601);
});

test('key is taken from Bearer or ?key=, never from tenantId', () => {
  const bearer = extractMcpKey({
    url: 'https://app.example/api/mcp?tenantId=t_evil',
    headers: { get: (n) => (n === 'authorization' ? 'Bearer jb_abc' : null) },
  });
  assert.equal(bearer, 'jb_abc');
  const query = extractMcpKey({
    url: 'https://app.example/api/mcp?key=jb_from_url',
    headers: { get: () => null },
  });
  assert.equal(query, 'jb_from_url');
  const pathKey = extractMcpKey({
    url: 'https://app.example/mcp/jb_from_path',
    headers: { get: () => null },
  });
  assert.equal(pathKey, 'jb_from_path');
});
