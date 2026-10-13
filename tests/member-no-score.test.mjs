// tests/member-no-score.test.mjs — JOBBY-BL-092: members can list/filter/mark
// jobs but never trigger a host Score/Evaluate run; scoring stays MCP-only.
//
// Route handlers use Next `@/` aliases, so this pins the source contract that
// `node --test` cannot import directly.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, finish, ROOT } from './helpers.mjs';

console.log('\nmember no-score — source contract (JOBBY-BL-092)');

const run = readFileSync(join(ROOT, 'web/src/app/api/run/route.ts'), 'utf8');
const openRole = readFileSync(join(ROOT, 'web/src/app/pipeline/open/page.tsx'), 'utf8');
const tools = readFileSync(join(ROOT, 'web/src/lib/mcp/tools.ts'), 'utf8');

// REQ-NS-002 / SCN-NS-003: member POST evaluate is rejected before any BullMQ
// job is queued (before the tracker-write-token / dispatch further down).
{
  const gate = run.indexOf('kind === "evaluate" && !isOperator(actor)');
  const status403 = run.indexOf('status: 403', gate);
  const writeToken = run.indexOf('acquireTrackerWrite()');
  if (gate !== -1 && status403 !== -1 && status403 - gate < 200 && gate < writeToken) {
    pass('POST /api/run rejects a non-operator evaluate before any write-token/dispatch work');
  } else {
    fail('POST /api/run must 403 member evaluate before queuing work (REQ-NS-002/SCN-NS-003)');
  }
}

// REQ-NS-002 / SCN-NS-002: the Score CTA on /pipeline/open only renders for a
// non-zero-key session — a stale localStorage cliId alone must not resurrect
// it (the same bug class BL-090/#91 fixed in config-form.tsx).
{
  const scoreButtons = [...openRole.matchAll(/hasCli(?:\s*&&\s*!zeroKey)?/g)];
  const gated = scoreButtons.filter((m) => /hasCli && !zeroKey/.test(m[0]));
  if (gated.length >= 2 && !/\{hasCli \? \(/.test(openRole) && !/\{hasCli && \(/.test(openRole)) {
    pass('pipeline/open Score controls require !zeroKey, not just a locally-cached cliId');
  } else {
    fail('pipeline/open must gate every Score button on !zeroKey too (REQ-NS-002)');
  }
}

// REQ-NS-003 / SCN-NS-004: MCP submit_score still writes with mandatory
// scored_by provenance, independent of the member host-Score block above.
{
  if (
    /required:\s*\["score",\s*"scored_by"\]/.test(tools) &&
    /scored_by is required/.test(tools)
  ) {
    pass('MCP submit_score keeps mandatory scored_by provenance');
  } else {
    fail('MCP submit_score must require scored_by (REQ-NS-003)');
  }
}

finish();
