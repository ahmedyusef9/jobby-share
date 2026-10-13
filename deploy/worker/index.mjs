#!/usr/bin/env node
/**
 * BullMQ worker — consumes jobby queue jobs and runs CLIs / openrouter-runner
 * against CAREER_OPS_ROOT (local-first mount).
 */
import { DelayedError, Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchJob } from "./dispatch.mjs";
import { ensureOpencodeConfig } from "./ensure-opencode-config.mjs";
import { migrateDefaultTenant, platformRoot, runForJob } from "./tenant-root.mjs";
import { tenantRootFor } from "../../scripts/resolve-root.mjs";
import {
  SCORE_KIND,
  SCORE_RUN_RETRY_MS,
  releaseScoreRunLock,
  tryAcquireScoreRunLock,
} from "../../scripts/score-fairness.mjs";

const oc = ensureOpencodeConfig();
if (oc.ok) console.log(`[worker] OpenCode → OmniRoute model=${oc.model}`);
else console.log(`[worker] OpenCode OmniRoute skipped (${oc.reason})`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const QUEUE = process.env.JOBBY_QUEUE_NAME || "jobby";

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

migrateDefaultTenant();
// this worker serves every tenant; concurrency is JOBBY_WORKER_CONCURRENCY (default 1).
console.log(`[worker] connecting ${REDIS_URL} queue=${QUEUE} platform=${platformRoot()}`);

const worker = new Worker(
  QUEUE,
  async (job, token) => {
    const kind = job.data?.kind || job.name;
    const owner = String(job.data?.tenantId ?? "").trim();
    console.log(`[worker] start job=${job.id} name=${job.name} kind=${kind} tenant=${owner || "-"}`);
    // D-023: enqueue allows one waiter, but a concurrency>1 dispatcher would
    // otherwise start that waiter beside the already-running Score. Park it.
    let scoreLock = false;
    if (kind === SCORE_KIND) {
      if (!owner) throw new Error("refusing to run a Score with no tenant");
      scoreLock = await tryAcquireScoreRunLock(connection, owner, String(job.id));
      if (!scoreLock) {
        await job.moveToDelayed(Date.now() + SCORE_RUN_RETRY_MS, token || job.token);
        throw new DelayedError();
      }
    }
    try {
      // Everything below runs with this job's tenant in scope. A job with no tenant
      // is refused here rather than defaulting into somebody else's directory.
      return await runForJob(job, () => dispatchJob(job));
    } finally {
      if (scoreLock) await releaseScoreRunLock(connection, owner, String(job.id));
    }
  },
  {
    connection,
    concurrency: Number(process.env.JOBBY_WORKER_CONCURRENCY) || 1,
  },
);

worker.on("completed", (job) => console.log(`[worker] done job=${job.id}`));
worker.on("failed", (job, err) => {
  if (err?.name === "DelayedError") return;
  const msg = err?.message || String(err);
  console.error(`[worker] fail job=${job?.id}`, msg);
  // Persist failure into the same snapshot the web UI polls — operators must not
  // need docker logs to see enqueue-vs-crash (JOBBY-BL-010).
  const runId = job?.data?.runId;
  if (!runId) return;
  try {
    // The snapshot belongs in the JOB'S tenant directory — which is where the web
    // UI polls for it. Writing it to the platform root put every tenant's failures
    // in one shared place, and put them somewhere the UI never looks.
    const owner = String(job?.data?.tenantId ?? "").trim();
    if (!owner) return;
    const dir = path.join(tenantRootFor(owner), ".career-ops-web", "runs");
    const safe = String(runId).replace(/[^a-z0-9_-]/gi, "");
    const snapFile = path.join(dir, `${safe}.json`);
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(snapFile, "utf8"));
    } catch {
      /* fresh */
    }
    if (existing?.finished && existing?.snapshot?.terminal?.type === "error") return;
    const steps = Array.isArray(existing?.snapshot?.steps) ? existing.snapshot.steps : [];
    steps.push({ type: "status", label: `Worker failed: ${msg}`.slice(0, 200) });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      snapFile,
      JSON.stringify({
        id: runId,
        kind: existing?.kind || job.data?.kind || "evaluate",
        finished: true,
        createdAt: existing?.createdAt || Date.now(),
        endedAt: Date.now(),
        snapshot: {
          steps,
          text: String(existing?.snapshot?.text || ""),
          terminal: { type: "error", msg: msg.slice(0, 400) },
        },
      }),
    );
  } catch (e) {
    console.error("[worker] could not persist failure snapshot", e?.message || e);
  }
});

// Health ping queue (optional)
const q = new Queue(QUEUE, { connection });
await q.waitUntilReady();
console.log("[worker] ready");
