#!/usr/bin/env node
/**
 * Optional scheduler — enqueues scan jobs on an interval (cron-ish).
 * Enable with compose profile `scheduler` or JOBBY_SCHEDULER=1.
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const QUEUE = process.env.JOBBY_QUEUE_NAME || "jobby";
const INTERVAL_MS = Number(process.env.JOBBY_SCAN_INTERVAL_MS) || 6 * 60 * 60 * 1000;

/**
 * Whose scans these are (JOBBY-BL-047).
 *
 * A recurring scan writes into somebody's directory and spends somebody's API
 * key, so the scheduler has to be told which account it is acting for. There is
 * no sensible default: picking one would silently spend a tenant's key on a
 * schedule they never set.
 */
const TENANT_ID = process.env.JOBBY_SCHEDULER_TENANT_ID?.trim();
if (!TENANT_ID) {
  console.error(
    "[scheduler] JOBBY_SCHEDULER_TENANT_ID is not set — refusing to enqueue scans " +
      "that would run in an arbitrary tenant's directory.",
  );
  process.exit(1);
}

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE, { connection });

async function enqueueScan() {
  const job = await queue.add(
    "scan",
    { kind: "scan", args: [], tenantId: TENANT_ID, enqueuedAt: Date.now() },
    { removeOnComplete: 50, removeOnFail: 20 },
  );
  console.log(`[scheduler] enqueued scan job=${job.id} tenant=${TENANT_ID}`);
}

console.log(`[scheduler] every ${INTERVAL_MS}ms → queue=${QUEUE}`);
await enqueueScan();
setInterval(() => {
  enqueueScan().catch((e) => console.error("[scheduler]", e));
}, INTERVAL_MS);
