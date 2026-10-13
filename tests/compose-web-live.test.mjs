// tests/compose-web-live.test.mjs — JOBBY-BL-079: the product UI is served by
// Compose on the host port recorded in .ports.yml, and 3001 is not that port.
//
// This is a live check, not a static one: deploy-exposure.test.mjs already
// proves the compose file and .ports.yml agree on the number, but a file
// agreeing with itself is not evidence the service actually answers. A 3001
// pass does not count (open_question, JOBBY-BL-079) — only a 200 from the
// recorded compose-web port does. Auth may 307 `/` to `/signin` on the same
// port; that still counts as the compose web service answering 200. If
// Compose is not up, this fails loudly rather than skipping.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import * as yaml from 'js-yaml';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\ncompose-web — live HTTP check (JOBBY-BL-079, SCN-DF-001)');

const ports = yaml.load(readFileSync(join(ROOT, '.ports.yml'), 'utf-8'));
const composeWebPort = Number(ports?.services?.['compose-web']);

function getStatus(port, timeoutMs = 5000, path = '/', hops = 0) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && hops < 4) {
        res.resume();
        try {
          const u = new URL(loc, `http://127.0.0.1:${port}/`);
          const destPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
          if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
            resolve(res.statusCode);
            return;
          }
          if (destPort !== port) {
            resolve(res.statusCode);
            return;
          }
          resolve(getStatus(port, timeoutMs, `${u.pathname}${u.search}`, hops + 1));
        } catch {
          resolve(res.statusCode);
        }
        return;
      }
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ── SCN-DF-001 / REQ-DF-002: the recorded compose-web port is 4700, not 3001
{
  if (composeWebPort === 4700) {
    pass(`.ports.yml records compose-web as ${composeWebPort}`);
  } else {
    fail(`.ports.yml compose-web must be 4700, got ${composeWebPort}`);
  }
  if (composeWebPort !== 3001) {
    pass('the recorded compose-web port is not 3001');
  } else {
    fail('the recorded compose-web port is 3001 — that is the rejected leftover, not compose-web');
  }
}

// ── SCN-DF-001 / REQ-DF-001: HTTP 200 from the compose web service ─────────
{
  const status = await getStatus(composeWebPort);
  if (status === 200) {
    pass(`http://127.0.0.1:${composeWebPort}/ answered 200 (compose web service, redirects followed)`);
  } else {
    fail(
      `http://127.0.0.1:${composeWebPort}/ did not answer 200 (got ${status === null ? 'no response' : status}). ` +
        `Start it with: docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build`,
    );
  }
}

// ── 3001 is not standing in for compose-web ─────────────────────────────────
{
  const status3001 = await getStatus(3001, 1500, '/', 0);
  if (status3001 !== 200) {
    pass('3001 does not answer 200 — it is not standing in for compose-web');
  } else {
    fail('3001 answered 200 — a 3001 pass does not satisfy REQ-DF-002 (compose-web is 4700)');
  }
}
