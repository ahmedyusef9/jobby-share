import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  MCP_JOB_LIST_META,
  formatMcpJobCard,
  mcpAbsoluteDashboardUrl,
  mcpDashboardOrigin,
  mcpJobListResponse,
  renderJobDetailBlock,
  renderJobsBriefsMarkdown,
  renderJobsTableBlock,
} from '../scripts/mcp-job-card.mjs';

describe('mcp-job-card', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('builds absolute dashboard links from AUTH_URL', () => {
    process.env.AUTH_URL = 'http://localhost:3001';
    delete process.env.JOBBY_APP_PUBLIC_URL;
    const card = formatMcpJobCard({
      company: 'Intel',
      title: 'Software Engineer',
      url: 'https://www.linkedin.com/jobs/view/4436201521',
      location: 'Haifa',
      source: 'linkedin',
    });
    assert.equal(card.links.posting, 'https://www.linkedin.com/jobs/view/4436201521');
    assert.match(card.links.jobby, /^http:\/\/localhost:3001\/pipeline\/open\?/);
    assert.match(card.links.jobby, /url=https%3A%2F%2Fwww\.linkedin\.com/);
    assert.equal(card.company, 'Intel');
    assert.equal(card.title, 'Software Engineer');
  });

  it('prefers JOBBY_APP_PUBLIC_URL over AUTH_URL', () => {
    process.env.JOBBY_APP_PUBLIC_URL = 'https://jobby.example.com';
    process.env.AUTH_URL = 'http://localhost:3001';
    assert.equal(mcpDashboardOrigin(), 'https://jobby.example.com');
    assert.equal(
      mcpAbsoluteDashboardUrl('/pipeline/42'),
      'https://jobby.example.com/pipeline/42',
    );
  });

  it('uses tracker number for jobby link when n is set', () => {
    process.env.AUTH_URL = 'http://localhost:3001';
    const card = formatMcpJobCard({
      company: 'AWS',
      title: 'SDE',
      n: '007',
      url: 'https://amazon.jobs/en/jobs/123',
      status: 'Evaluated',
      score: '4.2/5',
      kind: 'application',
    });
    assert.equal(card.links.jobby, 'http://localhost:3001/pipeline/7');
    assert.equal(card.trackerN, '7');
    assert.equal(card.status, 'Evaluated');
  });

  it('wraps lists with tableMarkdown and block footer', () => {
    const jobs = [formatMcpJobCard({ company: 'A', title: 'B', url: 'https://a.test/j' })];
    const out = mcpJobListResponse(jobs, { query: ['python'] });
    assert.equal(out.count, 1);
    assert.ok(out.tableMarkdown.includes('| Posted | Posting | Jobby |'));
    const block = renderJobsTableBlock(jobs, 'Job search', {
      meta: { plan: 'alpha', shown: 1, matched: 5, resultsLimit: 250, perSourceLimit: 30 },
    });
    assert.ok(block.includes('## Job search (1)'));
    assert.ok(block.includes('[Posting](https://a.test/j)'));
    assert.ok(block.includes('Show this table unchanged'));
    assert.ok(block.includes('plan: alpha'));
    assert.ok(block.includes('showing 1 of 5 matches'));
    assert.ok(block.includes('X.X/5'));
  });

  it('formats postedAt as YYYY-MM-DD or em dash', () => {
    const withDate = formatMcpJobCard({
      company: 'A',
      title: 'B',
      url: 'https://a.test/j',
      postedAt: '2026-03-15',
    });
    const block = renderJobsTableBlock([withDate], 'Jobs');
    assert.ok(block.includes('| 2026-03-15 |'));
    const noDate = formatMcpJobCard({ company: 'A', title: 'B', url: 'https://a.test/j' });
    assert.ok(renderJobsTableBlock([noDate], 'Jobs').includes('| — |'));
  });

  it('adds Briefs from summary and omits empty ones', () => {
    const withBrief = formatMcpJobCard({
      company: 'Neo',
      title: 'Software Engineer',
      url: 'https://a.test/1',
      summary: 'Neo builds AI security for enterprises.',
      description: 'Full long description about Neo AI security platform.',
    });
    const without = formatMcpJobCard({ company: 'X', title: 'Y', url: 'https://a.test/2' });
    const block = renderJobsTableBlock([withBrief, without], 'Job search');
    assert.ok(block.includes('## Briefs'));
    assert.ok(block.includes('### Neo — Software Engineer'));
    assert.ok(block.includes('Neo builds AI security'));
    assert.equal(block.includes('### X — Y'), false);
    assert.equal(renderJobsBriefsMarkdown([without]), '');
  });

  it('renderJobDetailBlock includes full Description', () => {
    const job = formatMcpJobCard({
      company: 'Wiz',
      title: 'Backend Engineer',
      url: 'https://a.test/wiz',
      description: 'Wiz is a cloud security platform. You will build APIs.',
    });
    const detail = renderJobDetailBlock(job, 'Recent search');
    assert.ok(detail.includes('## Description'));
    assert.ok(detail.includes('cloud security platform'));
    assert.equal(detail.includes('## Briefs'), false);
  });

  it('prefers JOBBY_MCP_PUBLIC_URL over localhost AUTH_URL', () => {
    process.env.JOBBY_MCP_PUBLIC_URL = 'https://your-machine.your-tailnet.ts.net';
    process.env.AUTH_URL = 'http://localhost:3001';
    delete process.env.JOBBY_APP_PUBLIC_URL;
    const card = formatMcpJobCard({
      company: 'Intel',
      title: 'Software Engineer',
      url: 'https://www.linkedin.com/jobs/view/1',
    });
    assert.match(card.links.jobby, /^https:\/\/your-machine\.your-tailnet\.ts\.net\/pipeline\/open\?/);
  });

  it('always includes links.jobby even when posting url is missing', () => {
    process.env.AUTH_URL = 'http://localhost:3001';
    const card = formatMcpJobCard({ company: 'KayHut', title: 'Senior Python', n: '12' });
    assert.equal(card.links.posting, null);
    assert.equal(card.links.jobby, 'http://localhost:3001/pipeline/12');
  });
});
