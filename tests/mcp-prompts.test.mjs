import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promptGetResult, promptsListResult } from '../scripts/mcp-prompts.mjs';

describe('mcp-prompts', () => {
  it('lists table, score, last_24h, and intel prompts', () => {
    const out = promptsListResult();
    const names = out.prompts.map((p) => p.name);
    assert.ok(names.includes('table'));
    assert.ok(names.includes('score'));
    assert.ok(names.includes('last_24h'));
    assert.ok(names.includes('intel'));
  });

  it('table prompt requires query', () => {
    assert.equal(promptGetResult('table', {}).error, 'query required');
  });

  it('table prompt instructs job_table + verbatim table', () => {
    const out = promptGetResult('table', { query: 'Intel python', country: 'Israel', since_days: '7' });
    const text = out.messages[0].content.text;
    assert.match(text, /job_table/);
    assert.match(text, /Intel python/);
    assert.match(text, /verbatim/);
  });

  it('score prompt asks for fit scores after table', () => {
    const out = promptGetResult('score', { query: 'backend', country: 'Israel' });
    const text = out.messages[0].content.text;
    assert.match(text, /Top Matches/);
    assert.match(text, /X\.X\/5/);
  });

  it('last_24h prompt uses since_days=1 and stale split', () => {
    const out = promptGetResult('last_24h', { query: 'python', country: 'Israel' });
    const text = out.messages[0].content.text;
    assert.match(text, /since_days=1/);
    assert.match(text, /stale/);
  });

  it('intel prompt defaults query and country', () => {
    const out = promptGetResult('intel', { since_days: '30' });
    const text = out.messages[0].content.text;
    assert.match(text, /Intel/);
    assert.match(text, /country="Israel"/);
  });
});
