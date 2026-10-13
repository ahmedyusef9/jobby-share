import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import { tenantId } from "@/lib/tenant";
import { isOperator, currentAccount } from "@/lib/entitlements";
import { enqueuePipeline, enqueueScan, getQueueSnapshot, queueEnabled } from "@/lib/queue/jobby-queue";
import { isScanQuotaError, endScan, reserveScan } from "@/lib/scan-quota";
import { workerConcurrency } from "@/lib/score-fairness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Enqueue scan / pipeline worker jobs when Redis is configured. */
async function handlePOST(req: Request) {
  if (!queueEnabled()) {
    return NextResponse.json(
      { error: "REDIS_URL not set — queue workers are disabled (in-process only)." },
      { status: 400 },
    );
  }
  let body: { kind?: string; args?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const kind = body.kind || "scan";
  // The tenant comes from the verified session, never from the request body — the
  // worker will run this job in whatever directory this names.
  const owner = tenantId();
  try {
    /*
     * Reserve BEFORE the kind branch (JOBBY-BL-050).
     *
     * `pipeline` used to return above this, and with no OpenRouter key on the
     * tenant the worker's pipeline falls back to the same full `scan.mjs` sweep.
     * A member who had spent all five daily scans could therefore keep scanning
     * forever by sending a different `kind` — verified: three accepted in a row
     * on an exhausted quota. Both kinds cost the host the same, so both reserve.
     */
    let eventId: string | null = null;
    try {
      ({ eventId } = await reserveScan(currentAccount(), owner));
    } catch (err) {
      if (isScanQuotaError(err)) {
        const q = err as { message: string; code: string; status: number; used?: number; limit?: number };
        return NextResponse.json(
          { error: q.message, code: q.code, used: q.used, limit: q.limit },
          { status: q.status },
        );
      }
      throw err;
    }

    try {
      const { jobId } =
        kind === "pipeline"
          ? await enqueuePipeline(owner, { scanEventId: eventId })
          : await enqueueScan(body.args || [], owner, { scanEventId: eventId });
      return NextResponse.json({ ok: true, jobId, kind: kind === "pipeline" ? "pipeline" : "scan" });
    } catch (e) {
      // Give the slot back, but never touch the run lock: it may be held by a
      // different scan of this tenant's that is running right now.
      await endScan(owner, eventId, { outcome: "cancelled" }, { releaseLock: false });
      throw e;
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "enqueue failed" },
      { status: 503 },
    );
  }
}

/**
 * Queue health for the Workers UI (JOBBY-BL-010, scoped in BL-047).
 *
 * A member sees their own jobs only. The queue is shared infrastructure, so the
 * unfiltered view — counts across every tenant, and failure text that carries
 * other people's file paths — is the operator's alone.
 */
async function handleGET() {
  try {
    const snap = await getQueueSnapshot(tenantId(), { all: isOperator(currentAccount()) });
    return NextResponse.json(snap);
  } catch (e) {
    return NextResponse.json(
      {
        queueEnabled: queueEnabled(),
        workerConcurrency: workerConcurrency(),
        error: e instanceof Error ? e.message : "queue status failed",
        counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        recentFailed: [],
      },
      { status: 503 },
    );
  }
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
