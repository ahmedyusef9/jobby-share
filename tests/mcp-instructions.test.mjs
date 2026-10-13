import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMcpClientInstructions } from '../scripts/mcp-instructions.mjs';

describe('mcp-instructions', () => {
  it('embeds plan KPIs in every client block', () => {
    const out = buildMcpClientInstructions({
      plan: 'alpha',
      mcpLimit: 500,
      mcpUsed: 12,
      scanLimit: 30,
      scanUsed: 2,
      resultsPerSource: 250,
      endpoint: 'https://example.ts.net/mcp',
      url: 'https://example.ts.net/mcp/jb_abc',
      localUrl: 'http://localhost:3001/api/mcp?key=jb_abc',
      local: false,
      connected: true,
    });
    assert.match(out.capsLine, /Plan: alpha/);
    assert.match(out.capsLine, /488 of 500/);
    assert.match(out.cursor, /250\/source/);
    assert.match(out.chatgpt, /No authentication/);
    assert.match(out.claude, /Authorization: Bearer/);
  });

  it('warns when MCP origin is local-only', () => {
    const out = buildMcpClientInstructions({
      plan: 'free',
      mcpLimit: 40,
      mcpUsed: 0,
      scanLimit: 3,
      scanUsed: 0,
      resultsPerSource: 40,
      endpoint: 'http://localhost:3001/mcp',
      local: true,
      connected: false,
    });
    assert.match(out.chatgpt, /public HTTPS/);
  });
});
