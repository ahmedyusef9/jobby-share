import { Queue } from "bullmq";
import IORedis from "ioredis";
import { JOB_STATES, recordJobEvent } from "@/lib/job-events";
import {
  SCORE_KIND,
  ScoreFairnessError,
  decideScoreAdmission,
  workerConcurrency,
} from "@/lib/score-fairness";

export const JOBBY_QUEUE_NAME = process.env.JOBBY_QUEUE_NAME || "jobby";

/** True when REDIS_URL is set — Score/scan go through BullMQ workers. */
export function queueEnabled(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

let connection: IORedis | null = null;
let queue: Queue | null = null;

function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL!.trim(), {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }
  return connection;
}

/**
 * Refuse to enqueue work that names no owner.
 *
 * Throwing is deliberate: a job with no tenant has to run *somewhere*, and every
 * default is somebody else's directory.
 */
function requireTenant(tenantId: string | undefined): asserts tenantId is string {
  if (!tenantId?.trim()) throw new Error("refusing to enqueue a job with no tenant");
}

async function emitQueued(jobId: string, tenantId: string, kind: string, engine?: string) {
  try {
    await recordJobEvent({
      jobId,
      tenantId,
      traceId: jobId,
      kind,
      engine,
      state: JOB_STATES.QUEUED,
    });
  } catch (err) {
    console.error("[queue] job_events queued write failed", err instanceof Error ? err.message : err);
  }
}

export function getJobbyQueue(): Queue {
  if (!queue) {
    queue = new Queue(JOBBY_QUEUE_NAME, { connection: getConnection() });
  }
  return queue;
}

export type EnqueueRunPayload = {
  runId: string;
  kind: string;
  input: string;
  cliId: string;
  /**
   * WHOSE job this is. Required, and carried in the job data rather than read
   * from the worker's environment (JOBBY-BL-047).
   *
   * The worker used to take its tenant from `JOBBY_TENANT_ID` — one value for the
   * whole container — so every queued job ran in that directory whoever enqueued
   * it. A member's scan read the operator's portals.yml, wrote into the operator's
   * data/, and spent the operator's API key. Exactly the bug the key store fixed
   * for inline runs, still live on the queued path.
   */
  tenantId: string;
  createdAt?: number;
};

function jobKindOf(job: { name?: string; data?: { kind?: string } }): string {
  return String(job.data?.kind || job.name || "");
}

function isTenantEvaluate(
  job: { name?: string; data?: { kind?: string; tenantId?: string } },
  tenantId: string,
): boolean {
  if (jobKindOf(job) !== SCORE_KIND) return false;
  return job.data?.tenantId === tenantId;
}

async function countTenantScoreJobs(tenantId: string): Promise<{ active: number; waiting: number }> {
  const q = getJobbyQueue();
  const waitingJobs = await q.getJobs(["waiting", "delayed"], 0, 499, true);
  const activeJobs = await q.getJobs(["active"], 0, 499, true);
  return {
    waiting: waitingJobs.filter((job) => isTenantEvaluate(job, tenantId)).length,
    active: activeJobs.filter((job) => isTenantEvaluate(job, tenantId)).length,
  };
}

async function withScoreAdmitLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const redis = getConnection();
  const key = `jobby:score-admit:${tenantId}`;
  const got = await redis.set(key, "1", "EX", 15, "NX");
  if (!got) {
    throw new ScoreFairnessError(
      "SCORE_FAIRNESS",
      "Another Score is being queued on this account. Retry in a moment.",
    );
  }
  try {
    return await fn();
  } finally {
    await redis.del(key);
  }
}

export async function enqueueRun(payload: EnqueueRunPayload): Promise<{ jobId: string }> {
  requireTenant(payload.tenantId);
  const kind = payload.kind || "evaluate";
  const add = async () => {
    if (kind === SCORE_KIND) {
      const counts = await countTenantScoreJobs(payload.tenantId);
      const decision = decideScoreAdmission(counts);
      if (!decision.ok) {
        throw new ScoreFairnessError(decision.code, decision.message, counts);
      }
    }
    const q = getJobbyQueue();
    const job = await q.add(
      kind,
      { ...payload, createdAt: payload.createdAt || Date.now() },
      {
        jobId: payload.runId,
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 1,
      },
    );
    return job;
  };
  const job = kind === SCORE_KIND ? await withScoreAdmitLock(payload.tenantId, add) : await add();
  const jobId = String(job.id);
  await emitQueued(jobId, payload.tenantId, kind, payload.cliId);
  return { jobId };
}

export async function enqueueScan(
  args: string[] = [],
  tenantId: string,
  extra: { scanEventId?: string | null } = {},
): Promise<{ jobId: string }> {
  requireTenant(tenantId);
  const q = getJobbyQueue();
  const job = await q.add(
    "scan",
    {
      kind: "scan",
      args,
      tenantId,
      scanEventId: extra.scanEventId || null,
      enqueuedAt: Date.now(),
    },
    { removeOnComplete: 50, removeOnFail: 20 },
  );
  const jobId = String(job.id);
  await emitQueued(jobId, tenantId, "scan");
  return { jobId };
}

/**
 * Pipeline carries a scan reservation for the same reason `scan` does
 * (JOBBY-BL-050): with no OpenRouter key on the tenant, `executePipeline` falls
 * back to the FULL `scan.mjs` sweep — the identical work, not a cheaper variant.
 * Leaving it unreserved made the daily cap advisory: one request with a different
 * `kind` walked straight past it.
 */
export async function enqueuePipeline(
  tenantId: string,
  extra: { scanEventId?: string | null } = {},
): Promise<{ jobId: string }> {
  requireTenant(tenantId);
  const q = getJobbyQueue();
  const job = await q.add(
    "pipeline",
    {
      kind: "pipeline",
      tenantId,
      scanEventId: extra.scanEventId ?? null,
      enqueuedAt: Date.now(),
    },
    { removeOnComplete: 50, removeOnFail: 20 },
  );
  const jobId = String(job.id);
  await emitQueued(jobId, tenantId, "pipeline");
  return { jobId };
}

export type QueuedRunState = {
  state: string;
  failedReason?: string;
  finishedOn?: number;
  /** 1-based place in the global waiting list. Null once the dispatcher has it. */
  queuePosition?: number | null;
  workerConcurrency?: number;
};

/**
 * BullMQ job state for a Score/PDF run (jobId === runId).
 *
 * `tenantId` is required: this reads Redis by job id, and run ids are guessable
 * (`run-{Date.now()}-{seq}`), so without an owner check a member could poll a
 * stranger's job and read its failure text (JOBBY-BL-047).
 */
export async function getQueuedRunState(
  runId: string,
  tenantId: string,
): Promise<QueuedRunState | null> {
  if (!queueEnabled() || !runId) return null;
  try {
    const q = getJobbyQueue();
    const job = await q.getJob(runId);
    if (!job) return null;
    const owner = typeof job.data?.tenantId === "string" ? job.data.tenantId : null;
    // Not yours (or predates BL-047, so ownerless): indistinguishable from absent.
    if (owner !== tenantId) return null;
    const state = await job.getState();
    const failedReason =
      state === "failed" ? String(job.failedReason || "Worker failed").slice(0, 400) : undefined;
    let queuePosition: number | null = null;
    if (state === "waiting" || state === "delayed") {
      const waiting = await q.getJobs(["waiting", "delayed"], 0, 499, true);
      const idx = waiting.findIndex((j) => String(j.id) === String(runId));
      queuePosition = idx === -1 ? null : idx + 1;
    }
    return {
      state,
      failedReason,
      finishedOn: job.finishedOn || undefined,
      queuePosition,
      workerConcurrency: workerConcurrency(),
    };
  } catch {
    return null;
  }
}

export type QueueSnapshot = {
  queueEnabled: boolean;
  workerConcurrency: number;
  counts: { waiting: number; active: number; completed: number; failed: number; delayed: number };
  recentFailed: { id: string; kind?: string; reason: string; finishedOn?: number }[];
};

const SNAPSHOT_STATES = ["waiting", "active", "completed", "failed", "delayed"] as const;

/**
 * Queue health for the Workers UI, **scoped to one tenant**.
 *
 * `getJobCounts` and an unfiltered `getJobs` are queue-wide, and the queue is
 * shared by every tenant. Returning them handed a brand-new member the operator's
 * job counts and failure text — which contains file paths, and those paths
 * contain a real person's name. Counts are therefore derived from the tenant's
 * own jobs, not from the queue totals.
 *
 * @param tenantId whose jobs to report on
 * @param opts.all operator view: the whole queue, for diagnosing the worker
 */
export async function getQueueSnapshot(
  tenantId: string,
  opts: { all?: boolean } = {},
): Promise<QueueSnapshot> {
  if (!queueEnabled()) {
    return {
      queueEnabled: false,
      workerConcurrency: workerConcurrency(),
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      recentFailed: [],
    };
  }
  const q = getJobbyQueue();
  const counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  const recentFailed: QueueSnapshot["recentFailed"] = [];

  // Bounded by removeOnComplete/removeOnFail (50–100 per state), so reading the
  // jobs to count them is cheap and, unlike getJobCounts, can be filtered.
  for (const state of SNAPSHOT_STATES) {
    const jobs = await q.getJobs([state], 0, 199);
    for (const job of jobs) {
      const owner = typeof job.data?.tenantId === "string" ? job.data.tenantId : null;
      // A job with no owner predates BL-047. It is not this tenant's, and only
      // the operator has any business seeing that it exists.
      if (!opts.all && owner !== tenantId) continue;
      counts[state] += 1;
      if (state === "failed" && recentFailed.length < 10) {
        recentFailed.push({
          id: String(job.id),
          kind: typeof job.data?.kind === "string" ? job.data.kind : undefined,
          reason: String(job.failedReason || "failed").slice(0, 240),
          finishedOn: job.finishedOn || undefined,
        });
      }
    }
  }

  return { queueEnabled: true, workerConcurrency: workerConcurrency(), counts, recentFailed };
}
