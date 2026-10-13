/**
 * E2E Real User Journeys (BL-063/BL-072).
 * Simulates complete end-to-end multi-turn conversations through MCP:
 *
 *   Journey 1: Onboarding → Upload CV → Edit section → Render PDF → Download
 *   Journey 2: Job hunt → Fetch stored jobs → Score with rationale → Verify provenance → Idempotent re-score
 *   Journey 3: Pipeline flow → Save discovered job → Move to tracker → Update status → Add notes
 */
import { test, expect } from 'playwright/test';
import { mcpKey } from './credentials.mjs';

const KEY = mcpKey();
const TAG = `journey-${Date.now()}`;
let request;

async function rpc(method, params = {}) {
  const res = await request.post('/api/mcp', {
    params: { key: KEY },
    data: { jsonrpc: '2.0', id: Date.now(), method, params },
  });
  return res;
}

async function callTool(name, args = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  expect(res.status()).toBe(200);
  const body = await res.json();
  if (body.error?.data?.code === 'MCP_DAILY' || body.error?.data?.code === 'TOOL_BUDGET') {
    test.skip(true, 'daily quota reached');
  }
  expect(body.error).toBeUndefined();
  const text = body.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

test.describe('Real User Journeys', () => {
  test.skip(!KEY, 'set JOBBY_E2E_MCP_KEY');

  test.beforeAll(async ({ playwright, baseURL }) => {
    request = await playwright.request.newContext({ baseURL });
  });
  test.afterAll(async () => {
    await request.dispose();
  });

  test('Journey 1: Complete CV Lifecycle (upload → patch → generate → download)', async () => {
    const v1 = `# Candidate ${TAG}\n\n## Experience\n\n### Software Dev — Startup Co (${TAG})\nBuilt feature X.\n`;
    const up1 = await callTool('resume_upload', { content: v1 });
    expect(up1.ok).toBe(true);

    // Verify stored
    const read1 = await callTool('get_resume');
    expect(read1.content).toContain(`Software Dev — Startup Co (${TAG})`);

    // Patch section
    const patch = await callTool('resume_update', {
      find: `Software Dev — Startup Co (${TAG})`,
      replace_with: `Principal Architect — Startup Co (${TAG})`,
    });
    expect(patch.ok).toBe(true);

    // Verify patch
    const read2 = await callTool('get_resume');
    expect(read2.content).toContain('Principal Architect');
    expect(read2.content).not.toContain('Software Dev');

    // Generate PDF
    const gen = await callTool('resume_generate', { max_pages: 1 });
    expect(gen.ok).toBe(true);
    expect(gen.download_link).toBeDefined();

    // Fetch signed link logged-out
    const linkUrl = new URL(gen.download_link, 'http://x');
    const linkRes = await request.get(linkUrl.pathname + linkUrl.search);
    expect(linkRes.status()).toBe(200);
  });

  test('Journey 2: Job Hunt & Scoring Loop (fetch → score → verify → re-score)', async () => {
    // Seed a job
    const app = await callTool('add_application', {
      company: `Corp ${TAG}`,
      role: `Staff AI Lead ${TAG}`,
      status: 'Evaluated',
      notes: 'Initial scan hit',
    });
    expect(app.ok).toBe(true);
    const jobId = String(app.n);

    // Turn 1: Fetch jobs feed
    const feed = await callTool('jobs_fetch', { source: 'tracker' });
    expect(feed._raw).toContain(`Staff AI Lead ${TAG}`);

    // Turn 2: Score it with model rationale
    const score1 = await callTool('submit_score', {
      job_id: jobId,
      score: 4.6,
      rationale: 'Perfect stack match with 5yr AI experience',
      scored_by: 'claude-3-5-sonnet',
    });
    expect(score1.ok).toBe(true);
    expect(score1.updated).toBe(true);

    // Turn 3: Re-score identically (idempotent no-op)
    const score2 = await callTool('submit_score', {
      job_id: jobId,
      score: 4.6,
      scored_by: 'claude-3-5-sonnet',
    });
    expect(score2.idempotent).toBe(true);

    // Turn 4: Fetch again and confirm score updated
    const apps = await callTool('search_applications', { query: TAG });
    expect(JSON.stringify(apps)).toContain('4.6/5');
  });

  test('Journey 3: Pipeline Progression (save → convert to tracker → update status)', async () => {
    // Save discovered job
    const saved = await callTool('save_jobs', {
      jobs: [{
        company: `Async ${TAG}`,
        title: `Backend Eng ${TAG}`,
        location: 'Remote',
        url: `https://example.com/jobs/${TAG}`,
      }],
    });
    expect(saved.added).toBeGreaterThan(0);

    // Appears in inbox
    const inbox = await callTool('list_inbox', {});
    expect(inbox._raw).toContain(`Backend Eng ${TAG}`);

    // Move to tracker as Applied
    const converted = await callTool('add_application', {
      company: `Async ${TAG}`,
      role: `Backend Eng ${TAG}`,
      status: 'Applied',
      notes: `Applied via portal on ${new Date().toISOString().slice(0, 10)}`,
    });
    expect(converted.ok).toBe(true);

    // Update status to Interview
    const updated = await callTool('update_application', {
      n: String(converted.n),
      status: 'Interview',
    });
    expect(updated.ok).toBe(true);

    // Verify in tracker search
    const tracker = await callTool('search_applications', { query: TAG });
    expect(JSON.stringify(tracker)).toContain('Interview');
  });
});
