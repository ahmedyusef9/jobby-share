// tests/web-ui-host-next-guard.test.mjs — JOBBY-BL-079: product runtime is
// Compose, not a host `next dev`. scripts/web-ui.sh must refuse to start
// unless JOBBY_ALLOW_HOST_NEXT=1 is set explicitly (an emergency escape).
//
// Runs the real script (not an extracted snippet) so this cannot drift from
// the guard it is pinning. Both cases stop at the guard/dependency check —
// neither reaches the point where a port would actually be bound, so the
// test needs no cleanup beyond its own scratch TMPDIR.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pass, fail, ROOT, getBash } from './helpers.mjs';

console.log('\nweb-ui.sh — host Next guard (JOBBY-BL-079)');

const SCRIPT = join(ROOT, 'scripts', 'web-ui.sh');

function runGuard(allowHostNext) {
  const scratch = mkdtempSync(join(tmpdir(), 'jobby-web-ui-guard-'));
  const env = { ...process.env, TMPDIR: scratch };
  if (allowHostNext) {
    env.JOBBY_ALLOW_HOST_NEXT = '1';
  } else {
    delete env.JOBBY_ALLOW_HOST_NEXT;
  }
  try {
    const stdout = execFileSync(getBash(), [SCRIPT], { cwd: ROOT, encoding: 'utf-8', timeout: 10000, env });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? null, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

// ── SCN-DF-002: no escape set → refused, no host Next bound ────────────────
{
  const { status, stderr } = runGuard(false);
  if (status !== 0) {
    pass('without JOBBY_ALLOW_HOST_NEXT the script exits non-zero');
  } else {
    fail('without JOBBY_ALLOW_HOST_NEXT the script exited 0 — it should have refused');
  }
  if (/host next is forbidden/.test(stderr)) {
    pass('the refusal names the guard ("host next is forbidden")');
  } else {
    fail(`expected "host next is forbidden" in stderr, got: ${JSON.stringify(stderr)}`);
  }
  if (/JOBBY_ALLOW_HOST_NEXT=1/.test(stderr)) {
    pass('the refusal tells the operator the escape variable');
  } else {
    fail(`expected JOBBY_ALLOW_HOST_NEXT=1 to be named in the refusal, got: ${JSON.stringify(stderr)}`);
  }
}

// ── SCN-DF-003: escape set → guard is not what stops it ────────────────────
{
  const { stderr } = runGuard(true);
  if (!/host next is forbidden/.test(stderr)) {
    pass('with JOBBY_ALLOW_HOST_NEXT=1 the script gets past the guard (no "forbidden" refusal)');
  } else {
    fail(`JOBBY_ALLOW_HOST_NEXT=1 still hit the guard: ${JSON.stringify(stderr)}`);
  }
}
