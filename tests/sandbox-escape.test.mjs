import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSandboxSpec, specLeaks } from '../deploy/worker/sandbox.mjs';

function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

test('sandbox spec mounts one tenant and no docker socket or Redis', () => {
  const platform = mkdtempSync(join(tmpdir(), 'jobby-sbx-'));
  try {
    mkdirSync(join(platform, 'tenants', 't_self'), { recursive: true });
    const spec = buildSandboxSpec(
      { tenantId: 't_self', runId: 'run-spec', extraEnv: { REDIS_URL: 'redis://secret:6379' } },
      {
        JOBBY_HOST_ROOT: platform,
        JOBBY_SANDBOX_IMAGE: 'jobby-worker:local',
        JOBBY_SANDBOX_NETWORK: 'jobby_sandbox',
        APPWRITE_API_KEY: 'must-not-leak',
        REDIS_URL: 'redis://secret:6379',
      },
    );
    const argv = spec.args.join(' ');
    assert.ok(argv.includes(`${platform}/tenants/t_self:/app/tenants/t_self:rw`));
    assert.equal(argv.includes('docker.sock'), false);
    assert.equal(argv.includes('t_other'), false);
    assert.equal(spec.env.REDIS_URL, undefined);
    assert.equal(spec.env.APPWRITE_API_KEY, undefined);
    assert.equal(spec.env.HOME.endsWith('/t_self/.home'), true);
    assert.equal(spec.network, 'jobby_sandbox');
    assert.deepEqual(specLeaks(spec), []);
  } finally {
    rmSync(platform, { recursive: true, force: true });
  }
});

test('compose requires JOBBY_HOST_ROOT instead of a nested PWD default', () => {
  const yml = readFileSync(new URL('../deploy/docker-compose.yml', import.meta.url), 'utf8');
  assert.equal(yml.includes('${JOBBY_HOST_ROOT:-${PWD}}'), false);
  assert.match(yml, /JOBBY_HOST_ROOT=\$\{JOBBY_HOST_ROOT:\?/);
});

test('escape: sandbox cannot read a sibling tenant, Redis, or the Docker socket', async (t) => {
  if (!dockerAvailable()) {
    t.skip('docker is not available on this host');
    return;
  }

  const platform = mkdtempSync(join(tmpdir(), 'jobby-esc-'));
  const selfDir = join(platform, 'tenants', 't_self');
  const otherDir = join(platform, 'tenants', 't_other');
  mkdirSync(selfDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'secret.txt'), 'SIBLING_SECRET\n');
  writeFileSync(
    join(selfDir, 'probe.js'),
    `const fs = require('fs');
const net = require('net');
const out = { sibling: false, redisEnv: Boolean(process.env.REDIS_URL), dockerSock: false, redisTcp: false };
try { fs.readFileSync('/app/tenants/t_other/secret.txt', 'utf8'); out.sibling = true; } catch {}
try { fs.accessSync('/var/run/docker.sock'); out.dockerSock = true; } catch {}
const s = net.connect({ host: 'redis', port: 6379 });
const finish = (hit) => {
  out.redisTcp = hit;
  try { s.destroy(); } catch {}
  process.stdout.write(JSON.stringify(out));
};
s.setTimeout(400, () => finish(false));
s.on('connect', () => finish(true));
s.on('error', () => finish(false));
`,
  );

  const spec = buildSandboxSpec(
    {
      tenantId: 't_self',
      runId: 'escape1',
      image: 'node:22-alpine',
      network: 'none',
      command: ['node', '/app/tenants/t_self/probe.js'],
    },
    { JOBBY_HOST_ROOT: platform, JOBBY_SANDBOX_IMAGE: 'node:22-alpine' },
  );

  try {
    const stdout = execFileSync('docker', spec.args, {
      encoding: 'utf8',
      timeout: 120_000,
    });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.sibling, false, 'read a sibling tenant file');
    assert.equal(result.redisEnv, false, 'inherited REDIS_URL');
    assert.equal(result.dockerSock, false, 'saw the Docker socket');
    assert.equal(result.redisTcp, false, 'connected to redis:6379');
  } finally {
    rmSync(platform, { recursive: true, force: true });
  }
});
