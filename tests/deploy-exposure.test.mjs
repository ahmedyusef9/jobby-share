// tests/deploy-exposure.test.mjs — what this deployment publishes (M7 phase 5).
//
// This exists because the file and the host disagreed. The compose file already
// said Redis was internal, while the running container was published on
// 0.0.0.0:6379 with no password — the stack had simply never been recreated
// after the file changed. A comment cannot notice that; a test can at least stop
// the file drifting back.
//
// Two rules, and neither is a preference:
//   1. Redis has no `ports` at all. It has no password and holds the job queue,
//      so anyone who can reach it can enqueue work into another account's
//      directory.
//   2. Nothing publishes on 0.0.0.0 — not by writing it, and not by writing a
//      bare "<host>:<container>", which means the same thing.
import { readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\ndeploy exposure — what the host publishes');

const check = (label, cond) => (cond ? pass(label) : fail(label));

const file = join(ROOT, 'deploy', 'docker-compose.yml');
const doc = yaml.load(readFileSync(file, 'utf-8'));
const services = doc?.services ?? {};

check('the compose file parses', Boolean(Object.keys(services).length));

// ── rule 1: redis is never published ────────────────────────────────
check('redis declares no published port', !('ports' in (services.redis ?? {})));

// ── rule 2: every published port names a bind address ───────────────
const published = [];
for (const [name, svc] of Object.entries(services)) {
  for (const entry of svc?.ports ?? []) {
    published.push({ name, entry: typeof entry === 'string' ? entry : JSON.stringify(entry) });
  }
}

check('something is published, or this test is vacuous', published.length > 0);

for (const { name, entry } of published) {
  // "127.0.0.1:4700:3000" and "${VAR:-127.0.0.1}:${JOBBY_WEB_PORT:-4700}:3000"
  // both qualify; a bare "4700:3000" does not, because Docker reads it as every
  // interface.
  const parts = entry.split(':');
  const hasHostAddr = parts.length >= 3;
  check(`${name} publishes with an explicit host address (${entry})`, hasHostAddr);
  check(`${name} does not publish on 0.0.0.0`, !/(^|[^\d.])0\.0\.0\.0/.test(entry));
  if (hasHostAddr) {
    const addr = parts.slice(0, parts.length - 2).join(':');
    // An unset variable must fall back to loopback, never to "everything".
    const fallback = addr.match(/:-([^}]*)\}/)?.[1] ?? addr;
    check(
      `${name} falls back to loopback when unconfigured (${fallback || '(empty)'})`,
      fallback === '127.0.0.1' || fallback === 'localhost' || fallback === '::1',
    );
  }
}

// ── the operator has to be told how to change it ────────────────────
{
  const example = readFileSync(join(ROOT, 'deploy', '.env.example'), 'utf-8');
  check('the bind address is documented for the operator', example.includes('JOBBY_BIND_ADDR'));
  check(
    'and the example never suggests 0.0.0.0',
    !/JOBBY_BIND_ADDR\s*=\s*0\.0\.0\.0/.test(example),
  );
}

{
  const ports = yaml.load(readFileSync(join(ROOT, '.ports.yml'), 'utf-8'));
  const hostPort = String(ports?.services?.['compose-web'] ?? '');
  const composeText = readFileSync(file, 'utf-8');
  check('.ports.yml declares compose-web', /^\d+$/.test(hostPort));
  check(
    `compose publishes JOBBY_WEB_PORT defaulting to compose-web (${hostPort})`,
    composeText.includes(`\${JOBBY_WEB_PORT:-${hostPort}}:3000`),
  );
  const [lo, hi] = String(ports.range || '').split('-').map(Number);
  const n = Number(hostPort);
  check(
    `compose-web ${hostPort} sits inside range ${ports.range}`,
    Number.isFinite(lo) && Number.isFinite(hi) && n >= lo && n <= hi,
  );
}
