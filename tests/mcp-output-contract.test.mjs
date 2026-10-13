import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MCP_OUTPUT_CONTRACT,
  MCP_CUSTOM_MD_SECTION,
  hasMcpOutputSection,
  mcpInitializeInstructions,
} from '../scripts/mcp-output-contract.mjs';

describe('mcp-output-contract', () => {
  it('initialize instructions reference output modes', () => {
    const text = mcpInitializeInstructions();
    assert.match(text, /table/);
    assert.match(text, /last_24h/);
    assert.match(text, /get_rules/);
  });

  it('contract requires verbatim table preservation', () => {
    assert.match(MCP_OUTPUT_CONTRACT, /Preserve the exact markdown table/);
    assert.match(MCP_OUTPUT_CONTRACT, /X\.X\/5/);
    assert.match(MCP_OUTPUT_CONTRACT, /stale/);
  });

  it('detects MCP section in custom md', () => {
    assert.equal(hasMcpOutputSection(''), false);
    assert.equal(hasMcpOutputSection(MCP_CUSTOM_MD_SECTION), true);
  });
});
