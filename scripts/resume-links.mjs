/**
 * Short-lived signed download links for tenant resume files (BL-055).
 *
 * A Connect key lets an assistant READ a CV through MCP; a download link lets
 * the assistant hand the file to a human. The link has to work in a browser
 * with no session and no key, so it carries its own HMAC-signed, expiring
 * grant: tenant + file + expiry, nothing else.
 *
 * Signing secret: JOBBY_LINK_SECRET, falling back to Auth.js's AUTH_SECRET.
 * No secret → signing fails loudly; links are never unsigned.
 */
import crypto from 'node:crypto';

const DEFAULT_TTL_SECONDS = 900; // 15 minutes

function linkSecret() {
  const s = process.env.JOBBY_LINK_SECRET || process.env.AUTH_SECRET;
  if (!s) throw new Error('No link secret configured (set JOBBY_LINK_SECRET or AUTH_SECRET)');
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(payload) {
  return crypto.createHmac('sha256', linkSecret()).update(payload).digest('base64url');
}

/**
 * @param {{tenantId: string, file: string, ttlSeconds?: number}} opts
 * @returns {{token: string, expiresAt: string}}
 */
export function signResumeLink({ tenantId, file, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!tenantId || !file) throw new Error('tenantId and file are required');
  const exp = Math.floor(Date.now() / 1000) + Math.max(30, Math.min(ttlSeconds, 3600));
  const payload = b64url(JSON.stringify({ t: tenantId, f: file, exp }));
  return { token: `${payload}.${hmac(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Verify a token. Returns the grant or null — null on any tamper, wrong key,
 * or expiry. Never throws for bad input; throws only when no secret exists.
 *
 * @param {string} token
 * @returns {{tenantId: string, file: string} | null}
 */
export function verifyResumeLink(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let grant;
  try {
    grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!grant || typeof grant.t !== 'string' || typeof grant.f !== 'string') return null;
  if (!Number.isFinite(grant.exp) || grant.exp * 1000 < Date.now()) return null;
  return { tenantId: grant.t, file: grant.f };
}
