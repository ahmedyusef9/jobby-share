/**
 * Shared e2e credential resolution (BL-060). ONE module so the ui-e2e skill
 * docs and the Playwright specs cannot drift:
 *
 *   member   → JOBBY_E2E_EMAIL / JOBBY_E2E_PASSWORD, else
 *              .career-ops-web/e2e.local.json { email, password }
 *   member B → JOBBY_E2E_MEMBER_B_EMAIL / PASSWORD, else
 *              e2e.local.json { memberB: { email, password } }
 *   operator → JOBBY_OPERATOR_SECRET (deploy/.env), used on /signin secret field
 *
 * Missing credentials are not an error: specs skip() with a reason, so the
 * suite stays green on machines without a seeded stack.
 */
import fs from 'node:fs';
import path from 'node:path';

const LOCAL_FILE = path.resolve(process.cwd(), '.career-ops-web', 'e2e.local.json');

function localFileCreds() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** @returns {{email?: string, password?: string} | null} */
export function memberCredentials(env = process.env) {
  const local = localFileCreds();
  const email = env.JOBBY_E2E_EMAIL || local.email;
  const password = env.JOBBY_E2E_PASSWORD || local.password;
  if (!email || !password) return null;
  return { email, password };
}

/** Optional second member for real cross-tenant isolation journeys. */
export function secondMemberCredentials(env = process.env) {
  const local = localFileCreds();
  const nested = local.memberB && typeof local.memberB === 'object' ? local.memberB : {};
  const email = env.JOBBY_E2E_MEMBER_B_EMAIL || nested.email || local.memberBEmail;
  const password = env.JOBBY_E2E_MEMBER_B_PASSWORD || nested.password || local.memberBPassword;
  if (!email || !password) return null;
  return { email, password };
}

/** Member Connect key for raw JSON-RPC MCP calls. */
export function mcpKey(env = process.env) {
  return env.JOBBY_E2E_MCP_KEY || localFileCreds().mcpKey || null;
}

/** @returns {{secret?: string} | null} */
export function operatorCredentials(env = process.env) {
  let secret = env.JOBBY_OPERATOR_SECRET;
  if (!secret) {
    const envFile = path.resolve(process.cwd(), 'deploy', '.env');
    try {
      const line = fs
        .readFileSync(envFile, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('JOBBY_OPERATOR_SECRET='));
      if (line) secret = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    } catch {
      /* no deploy/.env */
    }
  }
  return secret ? { secret } : null;
}
