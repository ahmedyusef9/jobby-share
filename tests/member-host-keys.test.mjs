// tests/member-host-keys.test.mjs — JOBBY-BL-090: members cannot store a host
// AI provider key, and leftover CTAs name MCP / Connect instead of Config paste-key.
//
// Route handlers use Next `@/` aliases, so this pins the source contract that
// `node --test` cannot import: POST /api/secrets is operator-gated before the
// body is parsed, and member-facing copy points at /connect.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, finish, ROOT } from './helpers.mjs';

console.log('\nmember host keys — source contract (JOBBY-BL-090)');

const secrets = readFileSync(join(ROOT, 'web/src/app/api/secrets/route.ts'), 'utf8');
const jobStore = readFileSync(join(ROOT, 'web/src/components/jobs/job-store.tsx'), 'utf8');
const configForm = readFileSync(join(ROOT, 'web/src/components/config-form.tsx'), 'utf8');
const explorer = readFileSync(join(ROOT, 'web/src/components/explore/explorer-view.tsx'), 'utf8');

// REQ-NK-002 / SCN-NK-002: member POST is rejected before a key is stored.
{
  const post = secrets.slice(secrets.indexOf('async function handlePOST'));
  const gate = post.indexOf('isOperator(currentAccount())');
  const parse = post.indexOf('await req.json()');
  if (gate !== -1 && parse !== -1 && gate < parse && /status:\s*403/.test(post.slice(0, parse))) {
    pass('POST /api/secrets returns 403 for non-operators before parsing the body');
  } else {
    fail('POST /api/secrets must 403 non-operators before req.json() (REQ-NK-002)');
  }
}

// REQ-NK-001: Config paste-key is operator-only (ModeCard + paste form).
{
  if (
    /canUseCli && \(/.test(configForm) &&
    /title="Paste an AI key"/.test(configForm) &&
    /mode === "key" && canUseCli/.test(configForm)
  ) {
    pass('Config paste-key ModeCard and form render only when canUseCli (operator)');
  } else {
    fail('Config still exposes paste-key without canUseCli (REQ-NK-001)');
  }
}

// REQ-NK-003: member CTAs name MCP / Connect, not Config paste-key.
{
  if (
    /Scoring runs in your own assistant — connect under Account → MCP/.test(jobStore) &&
    /href=\{zeroKey \? "\/connect" : "\/config"\}/.test(explorer) &&
    /Open MCP \/ Connect/.test(explorer)
  ) {
    pass('member no-engine / blocked-search CTAs name MCP / Connect, not Config paste-key');
  } else {
    fail('member CTAs still send people to Config for a host key (REQ-NK-003)');
  }
}

finish();
