/**
 * Per-job sandbox spec (D-022).
 *
 * The trusted dispatcher (this process) holds the Docker socket. The sandbox
 * container gets one tenant directory, the image's read-only code, that
 * tenant's provider key, a private HOME, and no Redis / Appwrite / Docker
 * credentials. Sibling tenants are not mounted, so `cd ..` cannot read them.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export const SANDBOX_DENIED_ENV = Object.freeze([
  'REDIS_URL',
  'AUTH_SECRET',
  'AUTH_GITHUB_SECRET',
  'AUTH_GOOGLE_SECRET',
  'APPWRITE_ENDPOINT',
  'APPWRITE_PROJECT_ID',
  'APPWRITE_API_KEY',
  'JOBBY_MASTER_KEY',
  'JOBBY_OPERATOR_SECRET',
  'DOCKER_HOST',
  'DOCKER_TLS_CERTDIR',
  'DOCKER_TLS_VERIFY',
]);

const DEFAULT_MEMORY = '2g';
const DEFAULT_CPUS = '2';
const DEFAULT_PIDS = '512';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function sandboxEnabled(env = process.env) {
  const raw = String(env.JOBBY_SANDBOX || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function hostTenantPath(tenantId, env = process.env) {
  const id = String(tenantId || '').trim();
  if (!id) throw new Error('sandbox: no tenant id');
  const hostRoot = String(env.JOBBY_HOST_ROOT || '').trim();
  if (hostRoot) return path.resolve(hostRoot, 'tenants', id);
  if (existsSync('/.dockerenv') || existsSync('/var/run/docker.sock')) {
    throw new Error(
      'JOBBY_HOST_ROOT is required when the dispatcher talks to the host Docker socket',
    );
  }
  const root = String(env.CAREER_OPS_ROOT || '').trim();
  if (!root) throw new Error('sandbox: CAREER_OPS_ROOT unset');
  return path.resolve(root, 'tenants', id);
}

/**
 * Docker `run` argv (not including `docker`). Pure: tests assert mounts and env
 * without talking to a daemon.
 *
 * @param {{
 *   tenantId: string,
 *   runId: string,
 *   image?: string,
 *   network?: string,
 *   memory?: string,
 *   cpus?: string,
 *   pidsLimit?: string | number,
 *   extraEnv?: Record<string, string>,
 *   command?: string[],
 * }} opts
 */
export function buildSandboxSpec(opts, env = process.env) {
  const tenantId = String(opts.tenantId || '').trim();
  const runId = String(opts.runId || '').replace(/[^a-z0-9_-]/gi, '') || 'job';
  if (!tenantId) throw new Error('sandbox: tenantId required');

  const image = opts.image || env.JOBBY_SANDBOX_IMAGE || 'jobby-worker:local';
  const network = opts.network || env.JOBBY_SANDBOX_NETWORK || 'jobby_sandbox';
  const memory = opts.memory || env.JOBBY_SANDBOX_MEMORY || DEFAULT_MEMORY;
  const cpus = opts.cpus || env.JOBBY_SANDBOX_CPUS || DEFAULT_CPUS;
  const pids = String(opts.pidsLimit || env.JOBBY_SANDBOX_PIDS || DEFAULT_PIDS);
  const timeoutMs = Number(env.JOBBY_SANDBOX_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const hostBind = hostTenantPath(tenantId, env);
  const containerTenant = `/app/tenants/${tenantId}`;
  const jobFile = `${containerTenant}/.career-ops-web/jobs/${runId}.json`;
  const home = `${containerTenant}/.home`;

  const sandboxEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.opencode/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    TZ: env.TZ || 'UTC',
    NODE_ENV: 'production',
    CAREER_OPS_ROOT: '/app',
    JOBBY_TENANT_ID: tenantId,
    JOBBY_JOB_FILE: jobFile,
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    JOBBY_JOBSPY_PYTHON: '/opt/jobspy/bin/python',
    ...(opts.extraEnv || {}),
  };
  for (const key of SANDBOX_DENIED_ENV) delete sandboxEnv[key];

  const args = [
    'run',
    '--rm',
    '--name',
    `jobby-job-${runId}`.slice(0, 63),
    '--network',
    network,
    '--memory',
    memory,
    '--cpus',
    cpus,
    '--pids-limit',
    pids,
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=512m',
    '-v',
    `${hostBind}:${containerTenant}:rw`,
  ];

  for (const [key, value] of Object.entries(sandboxEnv)) {
    if (value === undefined || value === '') continue;
    args.push('-e', `${key}=${value}`);
  }

  args.push(image);
  const command = opts.command || ['node', 'deploy/worker/sandbox-job.mjs'];
  args.push(...command);

  return {
    args,
    env: sandboxEnv,
    hostBind,
    containerTenant,
    jobFile,
    home,
    image,
    network,
    timeoutMs,
    binds: [`${hostBind}:${containerTenant}:rw`],
  };
}

export function specLeaks(spec) {
  const joined = spec.args.join('\x00');
  const leaks = [];
  if (joined.includes('docker.sock')) leaks.push('docker.sock');
  if (spec.env.REDIS_URL) leaks.push('REDIS_URL');
  if (spec.env.APPWRITE_API_KEY) leaks.push('APPWRITE_API_KEY');
  if (spec.env.JOBBY_MASTER_KEY) leaks.push('JOBBY_MASTER_KEY');
  if (spec.env.AUTH_SECRET) leaks.push('AUTH_SECRET');
  const tenantBinds = spec.binds.filter((b) => b.includes('/tenants/'));
  if (tenantBinds.length !== 1) leaks.push('tenant_bind_count');
  return leaks;
}
