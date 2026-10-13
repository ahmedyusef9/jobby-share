/**
 * Trusted dispatcher: run one BullMQ job, then decide the outcome from files.
 *
 * When JOBBY_SANDBOX=1 this launches a short-lived container. Otherwise it
 * spawns in-process (local tests / host worker) but still verifies artifacts.
 * The sandbox never writes job_events — it has no Appwrite key.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACT, verifyJobArtifacts } from '../../scripts/job-artifacts.mjs';
import { recordJobEvent } from '../../scripts/job-events.mjs';
import { JOB_STATES, errorClassOf } from '../../scripts/job-outcomes.mjs';
import { accountForTenantStrict } from '../../scripts/accounts.mjs';
import { executeRun, operatorSandboxEnv, patchRunSnapshot } from './execute-run.mjs';
import { executeScan, executePipeline } from './execute-scan.mjs';
import { buildSandboxSpec, sandboxEnabled, specLeaks } from './sandbox.mjs';
import { jobProviderEnv, tenantRoot, workerTenantId } from './tenant-root.mjs';

function jobKind(job) {
  return String(job?.data?.kind || job?.name || 'evaluate');
}

function jobEngine(job) {
  return String(job?.data?.cliId || '').slice(0, 64) || undefined;
}

function payloadPath(runId) {
  const safe = String(runId || 'job').replace(/[^a-z0-9_-]/gi, '');
  return path.join(tenantRoot(), '.career-ops-web', 'jobs', `${safe}.json`);
}

function jobIdOf(job) {
  return String(job?.id || job?.data?.runId || '').trim();
}

async function emit(job, state, extra = {}) {
  try {
    await recordJobEvent({
      jobId: jobIdOf(job),
      tenantId: workerTenantId(),
      traceId: jobIdOf(job),
      kind: jobKind(job),
      engine: jobEngine(job),
      state,
      ...extra,
    });
  } catch (err) {
    console.error('[dispatcher] job_events write failed', err instanceof Error ? err.message : err);
  }
}

function writePayload(job) {
  const runId = job.data?.runId || job.id;
  const file = payloadPath(runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(tenantRoot(), '.home'), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: job.id,
      data: {
        tenantId: workerTenantId(),
        runId,
        kind: jobKind(job),
        input: job.data?.input,
        cliId: job.data?.cliId,
        createdAt: job.data?.createdAt,
        args: job.data?.args,
        scanEventId: job.data?.scanEventId ?? null,
      },
    }),
  );
  return file;
}

function runInProcess(job) {
  const kind = jobKind(job);
  if (kind === 'scan') return executeScan(job);
  if (kind === 'pipeline') return executePipeline(job);
  return executeRun(job);
}

function dockerRun(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (c) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    child.stdout?.on('data', () => {
      /* sandbox writes its own run snapshot on the tenant mount */
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      spawn('docker', ['kill', spec.args[spec.args.indexOf('--name') + 1] || '']);
      const err = new Error('sandbox timed out');
      err.code = 'TIMED_OUT';
      reject(err);
    }, spec.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      err.code = err.code || 'SANDBOX';
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

async function runSandboxed(job) {
  const account = await accountForTenantStrict(workerTenantId());
  const spec = buildSandboxSpec({
    tenantId: workerTenantId(),
    runId: String(job.data?.runId || job.id || 'job'),
    extraEnv: {
      ...(job.data?.cliId ? jobProviderEnv(job.data.cliId) : {}),
      ...operatorSandboxEnv(account),
    },
  });
  const leaks = specLeaks(spec);
  if (leaks.length) {
    const err = new Error(`sandbox spec leaked ${leaks.join(',')}`);
    err.code = 'SANDBOX';
    throw err;
  }
  writePayload(job);
  const ran = await dockerRun(spec);
  return ran;
}

function finalize(job, terminal) {
  const runId = job.data?.runId;
  if (!runId) return;
  patchRunSnapshot(runId, jobKind(job), {
    finished: true,
    snapshot: { terminal },
  });
}

/**
 * @param {import('bullmq').Job} job
 */
export async function dispatchJob(job) {
  const started = Date.now();
  await emit(job, JOB_STATES.RUNNING, { fromState: JOB_STATES.QUEUED });

  let sandboxCode = 0;
  try {
    if (sandboxEnabled()) {
      const ran = await runSandboxed(job);
      sandboxCode = ran.code;
    } else {
      await runInProcess(job);
    }
  } catch (err) {
    const cls = errorClassOf(err);
    const state =
      cls === 'timeout'
        ? JOB_STATES.TIMED_OUT
        : cls === 'cancelled'
          ? JOB_STATES.CANCELLED
          : JOB_STATES.FAILED;
    await emit(job, state, {
      fromState: JOB_STATES.RUNNING,
      errorClass: cls,
      durationMs: Date.now() - started,
    });
    finalize(job, { type: 'error', msg: String(err instanceof Error ? err.message : err).slice(0, 400) });
    throw err;
  }

  const check = verifyJobArtifacts({
    kind: jobKind(job),
    tenantRoot: tenantRoot(),
    input: job.data?.input,
    sinceMs: Number(job.data?.createdAt) || started,
    runId: job.data?.runId,
  });

  if (check.artifactClass === ARTIFACT.SKIPPED && sandboxCode !== 0) {
    await emit(job, JOB_STATES.FAILED, {
      fromState: JOB_STATES.RUNNING,
      artifactClass: check.artifactClass,
      errorClass: 'exit_nonzero',
      durationMs: Date.now() - started,
    });
    const msg = `exit ${sandboxCode}`;
    finalize(job, { type: 'error', msg });
    throw new Error(msg);
  }

  if (!check.ok) {
    await emit(job, JOB_STATES.INCOMPLETE, {
      fromState: JOB_STATES.RUNNING,
      artifactClass: check.artifactClass,
      errorClass: 'incomplete',
      durationMs: Date.now() - started,
    });
    const msg = check.message || `incomplete: ${check.artifactClass}`;
    finalize(job, { type: 'error', msg });
    const err = new Error(msg);
    err.code = 'INCOMPLETE';
    throw err;
  }

  await emit(job, JOB_STATES.VALIDATED, {
    fromState: JOB_STATES.RUNNING,
    artifactClass: check.artifactClass,
  });
  await emit(job, JOB_STATES.SUCCEEDED, {
    fromState: JOB_STATES.VALIDATED,
    artifactClass: check.artifactClass,
    durationMs: Date.now() - started,
    errorClass: sandboxCode === 0 ? undefined : 'exit_nonzero',
  });
  finalize(job, { type: 'done', code: sandboxCode });
  return { ok: true, artifactClass: check.artifactClass };
}
