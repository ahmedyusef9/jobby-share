// tests/runner-tenant-root.test.mjs — the LLM runner reads and writes the
// CALLER's directory, not the checkout (JOBBY-BL-056).
//
// `openrouter-runner.mjs` resolved every user file against its own `__dirname`.
// On a single-user install that is the user's directory and nothing is wrong.
// On this fork it is nobody's: the worker runs the same script for whichever
// account queued the job, so a pipeline run read a pending list that was not the
// caller's, evaluated it against whatever cv.md sat in the checkout, and wrote
// the resulting report into a directory shared by every account.
//
// It is also the precondition for the cheap filter stage being worth anything —
// filtering the wrong tenant's pipeline is not a spend control.
//
// The check is behavioural: point the platform root somewhere temporary, give
// one tenant a pending list, and see the runner read THAT list. It also guards
// the patch itself, which `update-system.mjs apply` can revert.
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, ROOT, NODE } from './helpers.mjs';

console.log('\nopenrouter-runner — user files resolve to the calling tenant');

const check = (label, cond) => (cond ? pass(label) : fail(label));

const platform = mkdtempSync(join(tmpdir(), 'jobby-runner-'));
const tenant = join(platform, 'tenants', 't_alpha');
const neighbour = join(platform, 'tenants', 't_beta');

try {
  for (const dir of [tenant, neighbour]) {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, '.jobby-tenant'), '');
  }
  writeFileSync(
    join(tenant, 'data', 'pipeline.md'),
    '# Pipeline\n\n## Pending\n' +
      '- [ ] https://boards.test/alpha-1 | Alpha Co | Senior Backend Engineer\n' +
      '- [ ] https://boards.test/alpha-2 | Alpha Co | Staff Platform Engineer\n',
  );
  writeFileSync(
    join(neighbour, 'data', 'pipeline.md'),
    '# Pipeline\n\n## Pending\n- [ ] https://boards.test/beta-1 | Beta Co | Data Engineer\n',
  );

  const run = (tenantId, extra = {}) =>
    execFileSync(NODE, [join(ROOT, 'openrouter-runner.mjs'), 'pipeline'], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CAREER_OPS_ROOT: platform,
        JOBBY_TENANT_ID: tenantId,
        // Pins a model so the runner never reaches OpenRouter for its free-model
        // list; the budget below stops it before any evaluation regardless.
        CAREER_OPS_MODEL: 'test/offline',
        JOBBY_EVAL_BUDGET: '0',
        ...extra,
      },
    });

  const alpha = run('t_alpha');
  check("one tenant's run sees exactly that tenant's pending rows", /Prefilter: 2 pending/.test(alpha));
  check('and none of the neighbour\'s', !alpha.includes('beta-1') && !alpha.includes('Beta Co'));

  const beta = run('t_beta');
  check('the neighbour gets their own list, not the first tenant\'s', /Prefilter: 1 pending/.test(beta));

  check(
    'a zero budget stops before any evaluation is bought',
    alpha.includes('Nothing cleared the filter') && !alpha.includes('Evaluating'),
  );

  // The gates read the tenant's own files too, not the checkout's. Written after
  // the runs above so those keep their clean two-pending baseline.
  writeFileSync(
    join(tenant, 'data', 'blacklist.md'),
    '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Alpha Co | 2026-01 | all | never again |\n',
  );
  const blacklisted = run('t_alpha');
  check(
    "the tenant's own do-not-apply list is what filters their run",
    /Prefilter: 2 pending, 0 selected, 2 dropped/.test(blacklisted) && blacklisted.includes('never again'),
  );
} finally {
  rmSync(platform, { recursive: true, force: true });
}
