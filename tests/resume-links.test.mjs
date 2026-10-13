/**
 * BL-055 — signed resume download links: round-trip, expiry, tamper resistance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AUTH_SECRET = 'test-secret-for-resume-links-only';

const { signResumeLink, verifyResumeLink } = await import('../scripts/resume-links.mjs');

test('sign → verify round-trips tenant and file', () => {
  const { token, expiresAt } = signResumeLink({ tenantId: 't_abc123', file: 'cv.md' });
  const grant = verifyResumeLink(token);
  assert.deepEqual(grant, { tenantId: 't_abc123', file: 'cv.md' });
  assert.ok(new Date(expiresAt).getTime() > Date.now());
});

test('tampered payload is rejected', () => {
  const { token } = signResumeLink({ tenantId: 't_abc123', file: 'cv.md' });
  const sig = token.split('.')[1];
  const other = Buffer.from(
    JSON.stringify({ t: 't_other', f: 'cv.md', exp: Math.floor(Date.now() / 1000) + 600 }),
  ).toString('base64url');
  assert.equal(verifyResumeLink(`${other}.${sig}`), null);
});

test('tampered signature is rejected', () => {
  const { token } = signResumeLink({ tenantId: 't_abc123', file: 'output/x.pdf' });
  const forged = `${token.split('.')[0]}.${'A'.repeat(token.split('.')[1].length)}`;
  assert.equal(verifyResumeLink(forged), null);
});

test('expired but correctly-signed token is rejected', () => {
  const payload = Buffer.from(
    JSON.stringify({ t: 't_x', f: 'cv.md', exp: Math.floor(Date.now() / 1000) - 10 }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  assert.equal(verifyResumeLink(`${payload}.${sig}`), null);
});

test('garbage input never throws', () => {
  for (const bad of ['', '.', 'a.b', '../../etc/passwd', 'x.y.z']) {
    assert.equal(verifyResumeLink(bad), null);
  }
});
