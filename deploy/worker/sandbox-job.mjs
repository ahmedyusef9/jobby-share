#!/usr/bin/env node
/**
 * Sandbox entrypoint. Runs inside the per-job container with no Docker socket,
 * no Redis, and no Appwrite key. Reads the job payload from the tenant mount.
 */
import fs from 'node:fs';
import { executeRun } from './execute-run.mjs';
import { executeScan, executePipeline } from './execute-scan.mjs';
import { runForJob } from './tenant-root.mjs';

const file = process.env.JOBBY_JOB_FILE;
if (!file) {
  console.error('sandbox-job: JOBBY_JOB_FILE is unset');
  process.exit(2);
}

let job;
try {
  job = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error('sandbox-job: cannot read payload', err instanceof Error ? err.message : err);
  process.exit(2);
}

const tenantId = String(job?.data?.tenantId ?? '').trim();
if (!tenantId) {
  console.error('sandbox-job: payload has no tenantId');
  process.exit(2);
}

const kind = job.data?.kind;
try {
  await runForJob(job, () => {
    if (kind === 'scan') return executeScan(job);
    if (kind === 'pipeline') return executePipeline(job);
    return executeRun(job);
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
