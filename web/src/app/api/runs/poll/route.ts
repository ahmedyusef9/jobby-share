import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { tenantId, tenantRoot } from "@/lib/tenant";
import { getRunStatus, gcPersistedRuns, tailText } from "@/lib/core/run-store";
import { getQueuedRunState } from "@/lib/queue/jobby-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function runsDir(): string {
  return path.join(tenantRoot(), ".career-ops-web", "runs");
}

function safeId(id: string): string {
  return String(id).replace(/[^a-z0-9_-]/gi, "");
}

function loadJobJson(jobId: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(runsDir(), `${safeId(jobId)}.job.json`), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Poll worker progress from memory or disk JSON.
 * GET /api/runs/poll?runId=run-…&jobId=job-…&tail=80
 *
 * Used when SSE disconnects after refresh — Workers keeps updating from the
 * persisted snapshot until finished (or the client gives up).
 */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") || "";
  const jobId = url.searchParams.get("jobId") || "";
  const tail = Math.min(200, Math.max(10, Number(url.searchParams.get("tail")) || 80));

  // Opportunistic cleanup when UI is polling (cheap).
  if (Math.random() < 0.05) gcPersistedRuns();

  if (runId) {
    // BullMQ is the truth for queued vs running. The web process writes an
    // "Enqueued" snapshot immediately — that must not look like Evaluating.
    const qState = await getQueuedRunState(runId, tenantId());
    if (qState?.state === "failed") {
      return NextResponse.json({
        source: "queue",
        runId,
        finished: true,
        status: "error",
        error: qState.failedReason || "Worker failed",
        stepsTail: [{ kind: "status", label: qState.failedReason || "Worker failed", ts: Date.now() }],
        textTail: "",
        textLen: 0,
        stepCount: 0,
        updatedAt: qState.finishedOn || Date.now(),
      });
    }
    if (
      qState &&
      (qState.state === "waiting" || qState.state === "delayed")
    ) {
      const label =
        qState.queuePosition != null
          ? `Queued (position #${qState.queuePosition})`
          : "Queued — waiting for the dispatcher";
      return NextResponse.json({
        source: "queue",
        runId,
        finished: false,
        status: "queued",
        queuePosition: qState.queuePosition ?? null,
        workerConcurrency: qState.workerConcurrency,
        error: null,
        stepsTail: [{ kind: "status", label, ts: Date.now() }],
        textTail: "",
        textLen: 0,
        stepCount: 1,
        updatedAt: Date.now(),
      });
    }

    const st = getRunStatus(runId);
    if (st) {
      const steps = st.snapshot.steps || [];
      const text = String(st.snapshot.text || "");
      const terminal = st.snapshot.terminal;
      const errMsg = terminal?.type === "error" ? String(terminal.msg || "Error") : null;
      if (errMsg || st.finished || terminal) {
        return NextResponse.json({
          source: "run",
          runId,
          finished: st.finished || !!terminal,
          status: errMsg ? "error" : "done",
          error: errMsg,
          stepsTail: steps.slice(-40).map((s) => ({
            kind: s.type === "tool" ? "tool" : "status",
            label: String(s.name || s.label || s.type),
            ts: Date.now(),
          })),
          textTail: tailText(text, tail),
          textLen: text.length,
          stepCount: steps.length,
          updatedAt: st.endedAt || st.createdAt,
        });
      }
      return NextResponse.json({
        source: "run",
        runId,
        finished: false,
        status: qState?.state === "active" ? "running" : "running",
        error: null,
        stepsTail: steps.slice(-40).map((s) => ({
          kind: s.type === "tool" ? "tool" : "status",
          label: String(s.name || s.label || s.type),
          ts: Date.now(),
        })),
        textTail: tailText(text, tail),
        textLen: text.length,
        stepCount: steps.length,
        updatedAt: st.endedAt || st.createdAt,
      });
    }

    if (qState?.state === "active") {
      return NextResponse.json({
        source: "queue",
        runId,
        finished: false,
        status: qState?.state === "active" ? "running" : "running",
        error: null,
        stepsTail: [{ kind: "status", label: "Evaluating…", ts: Date.now() }],
        textTail: "",
        textLen: 0,
        stepCount: 1,
        updatedAt: Date.now(),
      });
    }
  }

  if (jobId) {
    const job = loadJobJson(jobId);
    if (job) {
      const text = String(job.text || job.output || "");
      const steps = Array.isArray(job.steps) ? job.steps : [];
      return NextResponse.json({
        source: "job",
        jobId,
        runId: job.runId || runId || null,
        finished: true,
        status: job.status === "error" ? "error" : "done",
        result: job.result || null,
        stepsTail: steps.slice(-40),
        textTail: tailText(text, tail),
        textLen: text.length,
        stepCount: steps.length,
        updatedAt: job.endedAt || job.startedAt || null,
      });
    }
  }

  return NextResponse.json({ error: "not found", finished: false, status: "unknown" }, { status: 404 });
}

export const GET = withTenant(handleGET);
