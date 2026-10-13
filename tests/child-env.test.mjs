import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pickChildEnv, providerEnvFor, tenantChildEnv } from '../scripts/resolve-root.mjs';

test('pickChildEnv never copies REDIS_URL, AUTH_SECRET, or NODE_OPTIONS', () => {
  const from = {
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    LANG: 'C',
    REDIS_URL: 'redis://secret:6379',
    AUTH_SECRET: 'session-root',
    JOBBY_OPERATOR_SECRET: 'op',
    AUTH_GITHUB_SECRET: 'gh',
    NODE_OPTIONS: '--require ./evil.js',
    OPENROUTER_API_KEY: 'sk-or-leak',
  };
  const env = pickChildEnv({}, from);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/tmp/home');
  assert.equal(env.LANG, 'C');
  assert.equal(env.REDIS_URL, undefined);
  assert.equal(env.AUTH_SECRET, undefined);
  assert.equal(env.JOBBY_OPERATOR_SECRET, undefined);
  assert.equal(env.AUTH_GITHUB_SECRET, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
});

test('providerEnvFor copies only that CLI\'s key', () => {
  const from = {
    OPENROUTER_API_KEY: 'sk-or',
    ANTHROPIC_API_KEY: 'sk-ant',
    REDIS_URL: 'redis://x',
  };
  const or = providerEnvFor('openrouter', from);
  assert.equal(or.OPENROUTER_API_KEY, 'sk-or');
  assert.equal(or.OPENROUTER_API_URL, undefined);
  assert.equal(or.ANTHROPIC_API_KEY, undefined);
  const orUrl = providerEnvFor('openrouter', {
    ...from,
    OPENROUTER_API_URL: 'https://omni.example/v1/chat/completions',
    OPENROUTER_TIMEOUT_MS: '120000',
  });
  assert.equal(orUrl.OPENROUTER_API_URL, 'https://omni.example/v1/chat/completions');
  assert.equal(orUrl.OPENROUTER_TIMEOUT_MS, '120000');
  const claude = pickChildEnv(providerEnvFor('claude', from), from);
  assert.equal(claude.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(claude.OPENROUTER_API_KEY, undefined);
  assert.equal(claude.REDIS_URL, undefined);
});

test('tenantChildEnv stamps tenant vars and drops platform secrets', () => {
  const prevRedis = process.env.REDIS_URL;
  const prevAuth = process.env.AUTH_SECRET;
  const prevCareer = process.env.CAREER_OPS_ROOT;
  const prevTenant = process.env.JOBBY_TENANT_ID;
  process.env.CAREER_OPS_ROOT = '/data';
  process.env.JOBBY_TENANT_ID = 'acme';
  process.env.REDIS_URL = 'redis://secret:6379';
  process.env.AUTH_SECRET = 'do-not-copy';
  process.env.PATH = process.env.PATH || '/usr/bin';
  try {
    const env = tenantChildEnv({ OPENROUTER_API_KEY: 'sk-job' });
    assert.equal(env.CAREER_OPS_ROOT, resolve('/data'));
    assert.equal(env.JOBBY_TENANT_ID, 'acme');
    assert.equal(env.HOME, resolve('/data/tenants/acme/.home'));
    assert.equal(env.OPENROUTER_API_KEY, 'sk-job');
    assert.equal(env.REDIS_URL, undefined);
    assert.equal(env.AUTH_SECRET, undefined);
  } finally {
    if (prevRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prevRedis;
    if (prevAuth === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prevAuth;
    if (prevCareer === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = prevCareer;
    if (prevTenant === undefined) delete process.env.JOBBY_TENANT_ID;
    else process.env.JOBBY_TENANT_ID = prevTenant;
  }
});
