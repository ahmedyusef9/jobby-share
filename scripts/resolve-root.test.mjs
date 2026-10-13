import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { platformRoot, resolveRoot } from './resolve-root.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = resolve(SCRIPT_DIR, '..');
const DOCTOR = join(CHECKOUT, 'doctor.mjs');
const MERGE = join(CHECKOUT, 'merge-tracker.mjs');
const SET_STATUS = join(CHECKOUT, 'set-status.mjs');
const RESERVE = join(CHECKOUT, 'reserve-report-num.mjs');

const savedCareer = process.env.CAREER_OPS_ROOT;
const savedTenant = process.env.JOBBY_TENANT_ID;

afterEach(() => {
  if (savedCareer === undefined) delete process.env.CAREER_OPS_ROOT;
  else process.env.CAREER_OPS_ROOT = savedCareer;
  if (savedTenant === undefined) delete process.env.JOBBY_TENANT_ID;
  else process.env.JOBBY_TENANT_ID = savedTenant;
});

test('without env, resolveRoot is the checkout (this file\'s parent)', () => {
  delete process.env.CAREER_OPS_ROOT;
  delete process.env.JOBBY_TENANT_ID;
  assert.equal(platformRoot(), CHECKOUT);
  assert.equal(resolveRoot(), CHECKOUT);
});

test('CAREER_OPS_ROOT + JOBBY_TENANT_ID resolves tenants/{id} regardless of cwd', () => {
  const plat = mkdtempSync(join(tmpdir(), 'jobby-root-'));
  process.env.CAREER_OPS_ROOT = plat;
  process.env.JOBBY_TENANT_ID = 'default';
  assert.equal(resolveRoot(), resolve(plat, 'tenants', 'default'));
  rmSync(plat, { recursive: true, force: true });
});

test('rejects a tenant id that would traverse', () => {
  process.env.CAREER_OPS_ROOT = '/data';
  process.env.JOBBY_TENANT_ID = '../etc';
  assert.throws(() => resolveRoot(), /invalid JOBBY_TENANT_ID/);
});

test('--target override skips tenant env', () => {
  process.env.CAREER_OPS_ROOT = '/data';
  process.env.JOBBY_TENANT_ID = 'default';
  assert.equal(resolveRoot('/tmp/other'), resolve('/tmp/other'));
});

test('after migration, missing JOBBY_TENANT_ID throws instead of reading the platform root', () => {
  const plat = mkdtempSync(join(tmpdir(), 'jobby-migrated-'));
  mkdirSync(join(plat, 'tenants', 'default'), { recursive: true });
  writeFileSync(join(plat, 'tenants', 'default', '.jobby-tenant'), 'default\n');
  process.env.CAREER_OPS_ROOT = plat;
  delete process.env.JOBBY_TENANT_ID;
  assert.throws(() => resolveRoot(), /set JOBBY_TENANT_ID/);
  rmSync(plat, { recursive: true, force: true });
});

function fixturePlatform() {
  const plat = mkdtempSync(join(tmpdir(), 'jobby-ac-'));
  const user = join(plat, 'tenants', 'default');
  mkdirSync(join(user, 'config'), { recursive: true });
  mkdirSync(join(user, 'modes'), { recursive: true });
  mkdirSync(join(user, 'data'), { recursive: true });
  mkdirSync(join(user, 'reports'), { recursive: true });
  writeFileSync(join(user, 'cv.md'), '# CV\n');
  writeFileSync(join(user, 'config', 'profile.yml'), 'candidate:\n  full_name: Test\n');
  writeFileSync(join(user, 'modes', '_profile.md'), '# profile\n');
  writeFileSync(join(user, 'portals.yml'), 'tracked_companies: []\n');
  writeFileSync(
    join(user, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n',
  );
  mkdirSync(join(plat, 'modes'), { recursive: true });
  mkdirSync(join(plat, 'templates'), { recursive: true });
  return { plat, user };
}

function runTool(script, args, plat, cwd) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: plat,
      JOBBY_TENANT_ID: 'default',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('doctor --json finds cv.md under the tenant from an arbitrary cwd', () => {
  const { plat } = fixturePlatform();
  const cwd = mkdtempSync(join(tmpdir(), 'jobby-cwd-'));
  const out = runTool(DOCTOR, ['--json'], plat, cwd);
  const j = JSON.parse(out.trim().split('\n').pop() || '{}');
  assert.equal(j.onboardingNeeded, false, JSON.stringify(j.missing));
  assert.deepEqual(j.missing ?? [], []);
  rmSync(plat, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test('merge-tracker dry-run uses the tenant tracker, not the platform root', () => {
  const { plat, user } = fixturePlatform();
  const cwd = mkdtempSync(join(tmpdir(), 'jobby-cwd-'));
  runTool(MERGE, ['--dry-run'], plat, cwd);
  assert.equal(existsSync(join(plat, 'data', 'applications.md')), false);
  assert.equal(existsSync(join(user, 'data', 'applications.md')), true);
  assert.equal(existsSync(join(user, 'batch', 'tracker-additions')), true);
  rmSync(plat, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test('set-status --dry-run resolves the tenant tracker, not the platform root', () => {
  const { plat, user } = fixturePlatform();
  const cwd = mkdtempSync(join(tmpdir(), 'jobby-cwd-'));
  try {
    runTool(SET_STATUS, ['Acme', 'Evaluated', '--dry-run', '--json'], plat, cwd);
    assert.fail('set-status should fail on an empty tracker');
  } catch (err) {
    const text = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    assert.match(text, /tenants\/default/);
    assert.equal(text.includes(join(plat, 'data', 'applications.md')), false);
    assert.match(text, new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  rmSync(plat, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test('reserve-report-num writes sentinels under the tenant reports dir', () => {
  const { plat, user } = fixturePlatform();
  const cwd = mkdtempSync(join(tmpdir(), 'jobby-cwd-'));
  const out = runTool(RESERVE, [], plat, cwd);
  const num = out.trim();
  assert.match(num, /^\d{3}$/);
  assert.equal(existsSync(join(user, 'reports', `${num}-RESERVED.md`)), true);
  assert.equal(existsSync(join(plat, 'reports', `${num}-RESERVED.md`)), false);
  rmSync(plat, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test('cv-export reads tenant cv.md from an arbitrary cwd', () => {
  const { plat } = fixturePlatform();
  const cwd = mkdtempSync(join(tmpdir(), 'jobby-cwd-'));
  const script = join(CHECKOUT, 'scripts', 'cv-export.mjs');
  try {
    runTool(script, ['--json'], plat, cwd);
    assert.fail('cv-export should reject a stub CV');
  } catch (err) {
    const text = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    assert.doesNotMatch(text, /cv\.md not found/);
    assert.match(text, /no candidate name|no experience/i);
  }
  rmSync(plat, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});
