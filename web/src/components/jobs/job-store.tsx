"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { scoreTone, normUrl } from "@/lib/format";
import { lsReadJson, lsWriteJson, lsRead, lsRemove } from "@/lib/storage";
import { SCORE_INFLIGHT_CAP } from "@/lib/score-fairness";

export type JobStep = { kind: "tool" | "status"; label: string; ts: number };
export type JobResult = { score: number | null; summary: string; tone: "good" | "warn" | "bad" | "muted" };

export type Job = {
  id: string;
  title: string;
  subtitle?: string;
  page?: string; // route the job was launched from / refers to
  input?: string; // the URL/posting it processed (links inbox rows to their worker)
  kind?: string;
  batchId?: string; // groups jobs fired together (e.g. "evaluate all Anthropic")
  status: "queued" | "running" | "done" | "error";
  steps: JobStep[];
  text: string;
  result?: JobResult;
  cost?: { tokens: number; usd?: number }; // per-run token cost (Claude result event) — local only
  /** Server-side run this job is attached to. Persisted so a reload can reattach
   *  instead of writing the work off as interrupted. */
  runId?: string;
  /** 1-based place in the shared BullMQ waiting list. Only while status is queued. */
  queuePosition?: number;
  startedAt: number;
  endedAt?: number;
};

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string };

/** The fields finish() needs to save a run log. On a reattach after reload the
 *  original StartOpts is long gone, so this is read back off the persisted job —
 *  hence the optional members, which Job has and StartOpts satisfies. */
type RunMeta = { title: string; subtitle?: string; page?: string; input?: string; kind?: string };

export type QueueStats = { pending: number; running: number; queued: number; paused: boolean };

/** One evaluate still waiting for a free slot (not yet a Job). */
export type PendingEval = { title: string; subtitle?: string; input: string };

type Ctx = {
  jobs: Job[];
  startJob: (opts: StartOpts) => string | null;
  removeJob: (id: string) => void;
  clearFinished: () => void;
  /** Queue evaluate runs behind the per-tenant Score cap (1 running + 1 waiting).
   *  The rest stay in this browser list until a Redis slot frees. */
  enqueueEvaluate: (items: StartOpts[]) => void;
  pauseQueue: () => void;
  resumeQueue: () => void;
  clearQueue: () => void;
  queueStats: QueueStats;
  /** Waiting evaluate items (company/role/url) — for per-job progress UI. */
  pendingQueue: PendingEval[];
};

const JobsContext = createContext<Ctx | null>(null);
export function useJobs() {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs must be used within <JobsProvider>");
  return c;
}

/** Pending Score queue — survives refresh (running workers reattach via runId). */
const QUEUE_MAX = 200;

/** Ollama/qwen on a single M1 runner cannot fan out — parallel Scores hang the lab. */
const MAX_CONCURRENT_OLLAMA = 1;

export function jobIsLive(job: Pick<Job, "status">): boolean {
  return job.status === "running" || job.status === "queued";
}

export function queuedCaption(job: Pick<Job, "queuePosition">): string {
  return job.queuePosition != null
    ? `Queued (position #${job.queuePosition})`
    : "Queued — waiting for the dispatcher";
}

/**
 * The configured CLI, falling back to the best installed one when nothing is
 * stored yet. localStorage is per browser profile, so a new profile (or a cleared
 * one) used to dead-end every AI-backed button on "No CLI configured" even with a
 * working, detected CLI on the machine. Only applies to CLI mode — an API-key
 * setup legitimately has no cliId and must keep reporting the original message.
 */
async function resolveCliId(): Promise<{ id: string | null; autoPicked: boolean; zeroKey: boolean }> {
  const cfg = lsReadJson<{ cliId?: string; mode?: string }>("config", {});
  if (cfg.cliId) return { id: cfg.cliId, autoPicked: false, zeroKey: false };
  if (cfg.mode && cfg.mode !== "cli") return { id: null, autoPicked: false, zeroKey: false };

  try {
    const res = await fetch("/api/clis");
    if (!res.ok) return { id: null, autoPicked: false, zeroKey: false };
    const data = await res.json();
    const zeroKey = data.zeroKey === true;
    const installed = (Array.isArray(data.clis) ? data.clis : []).filter(
      (c: { installed?: boolean }) => c.installed,
    ) as { id: string }[];
    // career-ops is developed and verified against Claude Code — prefer it.
    const pick = installed.find((c) => c.id === "claude") || installed[0];
    if (!pick) return { id: null, autoPicked: false, zeroKey };
    lsWriteJson("config", { ...cfg, cliId: pick.id });
    return { id: pick.id, autoPicked: true, zeroKey };
  } catch {
    return { id: null, autoPicked: false, zeroKey: false };
  }
}

function parseVerdict(text: string): JobResult {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    const score = parseFloat(m[1]);
    return { score, summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90), tone: scoreTone(`${score}`) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) {
    const score = parseFloat(s[1]);
    return { score, summary: "", tone: scoreTone(`${score}`) };
  }
  return { score: null, summary: "", tone: "muted" };
}

type PollPayload = {
  finished?: boolean;
  status?: string;
  error?: string | null;
  result?: { score: number | null; summary?: string; tone?: string } | null;
  stepsTail?: { kind?: string; label?: string; ts?: number }[];
  textTail?: string;
  queuePosition?: number | null;
};

function resultFromPoll(data: PollPayload, text: string): JobResult | undefined {
  if (data.result?.score != null) {
    return {
      score: data.result.score,
      summary: String(data.result.summary || "").replace(/\s*VERDICT:\s*[\d.]+\s*\/\s*5[^\n]*/i, "").trim().slice(0, 90),
      tone: (data.result.tone as JobResult["tone"]) || scoreTone(`${data.result.score}`),
    };
  }
  const parsed = parseVerdict(text);
  return parsed.score != null ? parsed : undefined;
}

type TrackerHit = { score: number; summary: string; tone: JobResult["tone"]; n: string };

function companyFromJobTitle(title?: string): string {
  // "Score · Ovalix" / "Score · NVIDIA"
  const m = String(title || "").match(/·\s*(.+)$/);
  return (m?.[1] || "").trim().toLowerCase();
}

function appScoreNum(score?: string): number {
  const sn = score ? parseFloat(String(score)) : NaN;
  return Number.isFinite(sn) ? sn : NaN;
}

/** Tracker is ground truth after refresh — Scores often finish with no live log. */
async function lookupTrackerScore(opts: {
  input?: string;
  title?: string;
  subtitle?: string;
}): Promise<TrackerHit | null> {
  try {
    const pipe = await fetch("/api/pipeline");
    if (!pipe.ok) return null;
    const d = await pipe.json();
    const apps = Array.isArray(d.applications) ? d.applications : [];
    const reportUrls = Array.isArray(d.reportUrls) ? d.reportUrls : [];
    const byNum = new Map(
      apps.map((a: { n: string }) => [String(parseInt(a.n, 10)), a]),
    );

    const toHit = (app: { score?: string; n?: string; notes?: string }, n: string | number): TrackerHit | null => {
      const sn = appScoreNum(app.score);
      if (!Number.isFinite(sn)) return null;
      return {
        score: sn,
        summary: String(app.notes || "").slice(0, 90),
        tone: scoreTone(`${sn}`),
        n: String(app.n || n),
      };
    };

    // 1) Exact posting URL (report header ↔ worker input)
    if (opts.input) {
      const want = normUrl(opts.input);
      let best: { score?: string; n?: string; notes?: string } | null = null;
      let bestN = -1;
      for (const { url, n } of reportUrls as { url: string; n: string }[]) {
        if (normUrl(url) !== want) continue;
        const num = parseInt(n, 10);
        if (Number.isNaN(num) || num < bestN) continue;
        const app = byNum.get(String(num)) as { score?: string; n?: string; notes?: string } | undefined;
        if (app) {
          best = app;
          bestN = num;
        }
      }
      const hit = best ? toHit(best, bestN) : null;
      if (hit) return hit;
    }

    // 2) Company (+ role) — Inbox URL may differ from report URL (LinkedIn vs Indeed).
    const company = companyFromJobTitle(opts.title);
    const role = String(opts.subtitle || "").trim().toLowerCase();
    if (company) {
      let bestApp: { score?: string; n?: string; notes?: string; role?: string } | null = null;
      let bestN = -1;
      let bestOverlap = -1;
      for (const a of apps as { n: string; company?: string; role?: string; score?: string; notes?: string }[]) {
        const c = String(a.company || "").trim().toLowerCase();
        if (!c || (!c.includes(company) && !company.includes(c.split(/\s*\(/)[0].trim()))) continue;
        const r = String(a.role || "").trim().toLowerCase();
        const tokens = (s: string) =>
          s.split(/[^a-z0-9+#]+/).filter((t) => t.length > 2 && !["senior", "staff", "the", "and", "for"].includes(t));
        const wantTok = role ? tokens(role) : [];
        const haveTok = r ? tokens(r) : [];
        let overlap = 0;
        if (wantTok.length) {
          const have = new Set(haveTok);
          overlap = wantTok.filter((t) => have.has(t)).length;
          // Need a real role match when many rows share a company (NVIDIA).
          if (overlap < Math.min(2, wantTok.length)) continue;
        }
        const num = parseInt(a.n, 10);
        if (Number.isNaN(num) || !Number.isFinite(appScoreNum(a.score))) continue;
        if (overlap > bestOverlap || (overlap === bestOverlap && num > bestN)) {
          bestApp = a;
          bestN = num;
          bestOverlap = overlap;
        }
      }
      const hit = bestApp ? toHit(bestApp, bestN) : null;
      if (hit) return hit;
    }

    return null;
  } catch {
    return null;
  }
}

async function loadSavedJob(jobId: string): Promise<{
  status: "done" | "error";
  text: string;
  result?: JobResult;
  endedAt?: number;
  steps?: JobStep[];
} | null> {
  try {
    const saved = await fetch(`/api/runs/save?id=${encodeURIComponent(jobId)}`);
    if (!saved.ok) return null;
    const data = await saved.json();
    const text = String(data.text || "");
    const result =
      data.result?.score != null
        ? {
            score: data.result.score as number | null,
            summary: String(data.result.summary || "")
              .replace(/\s*VERDICT:\s*[\d.]+\s*\/\s*5[^\n]*/i, "")
              .trim()
              .slice(0, 90),
            tone: (data.result.tone as JobResult["tone"]) || scoreTone(`${data.result.score}`),
          }
        : parseVerdict(text);
    return {
      status: data.status === "error" ? "error" : "done",
      text,
      result: result.score != null ? result : undefined,
      endedAt: typeof data.endedAt === "number" ? data.endedAt : undefined,
      steps: Array.isArray(data.steps) ? data.steps : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Short poll only — Scores already landed in Pipeline often have no live SSE.
 * Cap at ~20s so Workers never spins for minutes on a finished job.
 */
async function pollRunUntilSettled(
  jobId: string,
  runId: string | undefined,
  _meta: RunMeta,
  patch: (id: string, fn: (j: Job) => Job) => void,
  jobsRef: { current: Job[] },
  finish: (status: "done" | "error", lastLabel?: string, textOverride?: string, resultOverride?: JobResult) => void,
): Promise<boolean> {
  const loopStart = Date.now();
  const queuedMaxMs = 900_000;
  const runningMaxMs = 20_000;
  let lastText = "";
  let labeled = false;
  let sawRunningAt = 0;
  let lastQueued = false;
  while (true) {
    const now = Date.now();
    if (sawRunningAt) {
      if (now - sawRunningAt > runningMaxMs) break;
    } else if (now - loopStart > queuedMaxMs) {
      break;
    }
    const cur = jobsRef.current.find((j) => j.id === jobId);
    if (cur?.status === "done" || cur?.status === "error") return true;
    const qs = new URLSearchParams({ tail: "80" });
    if (runId) qs.set("runId", runId);
    qs.set("jobId", jobId);
    try {
      const res = await fetch(`/api/runs/poll?${qs}`);
      if (res.ok) {
        const data = (await res.json()) as PollPayload;
        const textTail = String(data.textTail || "");
        if (textTail) lastText = textTail;
        const stepsTail = Array.isArray(data.stepsTail)
          ? data.stepsTail.map((s) => ({
              kind: (s.kind === "tool" ? "tool" : "status") as "tool" | "status",
              label: String(s.label || ""),
              ts: typeof s.ts === "number" ? s.ts : Date.now(),
            }))
          : null;

        if (data.finished) {
          if (data.status === "error") {
            finish("error", data.error || "Worker error", lastText || textTail || undefined);
            return true;
          }
          const result = resultFromPoll(data, lastText || textTail);
          finish("done", "Done (restored from log)", lastText || textTail || undefined, result);
          return true;
        }

        if (data.status === "queued") {
          lastQueued = true;
          patch(jobId, (j) => ({
            ...j,
            status: "queued",
            queuePosition: typeof data.queuePosition === "number" ? data.queuePosition : j.queuePosition,
            text: textTail || j.text,
            steps: stepsTail && stepsTail.length ? mergeStepsTail(j.steps, stepsTail) : j.steps,
          }));
        } else {
          lastQueued = false;
          if (!sawRunningAt) sawRunningAt = now;
          patch(jobId, (j) => ({
            ...j,
            status: "running",
            queuePosition: undefined,
            text: textTail || j.text,
            steps: stepsTail && stepsTail.length ? mergeStepsTail(j.steps, stepsTail) : j.steps,
          }));
          if (!labeled) {
            labeled = true;
            patch(jobId, (j) => ({
              ...j,
              steps: [...j.steps.filter((s) => !/polling saved/i.test(s.label)), { kind: "status", label: "Polling saved worker log…", ts: Date.now() }],
            }));
          }
        }
      } else if (res.status === 404) {
        break;
      }
    } catch {
      /* keep polling briefly */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (lastQueued) return true;

  const saved = await loadSavedJob(jobId);
  if (saved) {
    finish(
      saved.status,
      "Done (restored from saved job)",
      saved.text || undefined,
      saved.result,
    );
    return true;
  }
  return false;
}

function mergeStepsTail(existing: JobStep[], tail: JobStep[]): JobStep[] {
  if (!tail.length) return existing;
  // Replace trailing activity with the server's last window (avoids unbounded growth).
  const head = existing.slice(0, Math.max(0, existing.length - tail.length));
  const lastHead = head[head.length - 1]?.label;
  const firstTail = tail[0]?.label;
  if (lastHead && firstTail && lastHead === firstTail) return [...head.slice(0, -1), ...tail];
  return [...head, ...tail];
}

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  // Pending evaluate runs waiting for a free slot (+ pause). Persisted so a
  // page refresh keeps "16 queued" instead of wiping the batch.
  const [queue, setQueue] = useState<StartOpts[]>([]);
  const [paused, setPaused] = useState(false);
  const seq = useRef(0);
  const loaded = useRef(false);
  /** Block the pump until localStorage queue hydrate finishes (avoids a flash empty drain). */
  const queueReady = useRef(false);
  const fairnessHoldUntil = useRef(0);
  // Latest jobs/startJob read from inside stable callbacks + the pump effect
  // without adding them to dependency arrays (which would thrash identities).
  const jobsRef = useRef<Job[]>(jobs);
  jobsRef.current = jobs;
  const startJobRef = useRef<((opts: StartOpts) => string | null) | null>(null);
  // Guards against a second reattach for the same job (React strict mode runs
  // effects twice in dev, and two readers on one run would duplicate its output).
  const reattached = useRef<Set<string>>(new Set());
  // co-job-done once per job — finish→refresh→stream-abort must not re-fire it.
  const announcedDone = useRef<Set<string>>(new Set());

  // persist jobs
  useEffect(() => {
    if (!loaded.current) return;
    lsWriteJson("jobs", jobs.slice(0, 40));
  }, [jobs]);

  // persist score queue + pause
  useEffect(() => {
    if (!loaded.current || !queueReady.current) return;
    lsWriteJson("eval-queue", {
      paused,
      items: queue.slice(0, QUEUE_MAX).map((q) => ({
        title: q.title,
        subtitle: q.subtitle,
        kind: q.kind || "evaluate",
        input: q.input,
        page: q.page || "/pipeline",
        batchId: q.batchId,
      })),
    });
  }, [queue, paused]);

  const patch = useCallback((id: string, fn: (j: Job) => Job) => {
    setJobs((js) => js.map((j) => (j.id === id ? fn(j) : j)));
  }, []);

  // Reads an NDJSON run stream into a job. Shared by a fresh start and by a
  // reattach, so both rebuild identical state from the same event vocabulary.
  const consume = useCallback(
    async (jobId: string, meta: RunMeta, res: Response, reconnectDepth = 0) => {
      let text = "";
      let verdictLine = ""; // latched separately so the 8000-char tail can't drop it
      let doneTokens = 0; // per-run token cost, forwarded on the done event (#6)
      let doneCostUsd: number | null = null;
      let steps: JobStep[] = [];
      let settled = false; // terminal — never revive as "running" after this
      // Token streams would otherwise re-render Workers / detail on every chunk
      // (ReactMarkdown + activity log thrash). Coalesce text into ~250ms paints.
      let textFlush: ReturnType<typeof setTimeout> | null = null;
      const flushText = () => {
        textFlush = null;
        patch(jobId, (j) => ({ ...j, text }));
      };
      const finish = (status: "done" | "error", lastLabel?: string, textOverride?: string, resultOverride?: JobResult) => {
        if (settled) return;
        settled = true;
        if (textOverride) text = textOverride;
        if (textFlush) {
          clearTimeout(textFlush);
          textFlush = null;
        }
        const result =
          status === "done" ? resultOverride ?? parseVerdict(verdictLine || text) : undefined;
        const cost = status === "done" && doneTokens > 0 ? { tokens: doneTokens, usd: doneCostUsd ?? undefined } : undefined;
        patch(jobId, (j) => ({
          ...j,
          status,
          result: result?.score != null ? result : status === "done" ? j.result : undefined,
          cost,
          text,
          endedAt: Date.now(),
          steps: lastLabel ? [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : j.steps,
        }));
        // persist a readable log file so refresh / Workers can restore history
        if (status === "done" || status === "error") {
          const cur = jobsRef.current.find((j) => j.id === jobId);
          fetch("/api/runs/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: jobId,
              title: meta.title,
              subtitle: meta.subtitle,
              page: meta.page,
              input: meta.input,
              kind: meta.kind,
              result: status === "done" ? result : undefined,
              cost,
              steps,
              output: text,
              status,
              startedAt: cur?.startedAt,
              endedAt: Date.now(),
              runId: cur?.runId,
            }),
          }).catch(() => {});
        }
        // Tell server-snapshot surfaces (Today, pipeline) to refetch — once.
        // A second fire (reattach replay) caused router.refresh loops that made
        // Workers look stuck spinning after the Score had already finished.
        if (
          status === "done" &&
          typeof window !== "undefined" &&
          (meta.kind === "evaluate" || meta.kind === "pdf") &&
          !announcedDone.current.has(jobId)
        ) {
          announcedDone.current.add(jobId);
          window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: meta.kind, input: meta.input } }));
        }
      };

      try {
        if (!res.body) {
          finish("error", "No response body");
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.type === "replay") {
                // The server is about to resend the run's whole history. Clear
                // what's rendered so a reattach can't double-count steps.
                text = "";
                verdictLine = "";
                steps = [];
                patch(jobId, (j) => ({ ...j, text: "", steps: [] }));
              } else if (ev.type === "tool") {
                steps.push({ kind: "tool", label: ev.name, ts: Date.now() });
                patch(jobId, (j) => ({
                  ...j,
                  status: "running",
                  queuePosition: undefined,
                  steps: [...j.steps, { kind: "tool", label: ev.name, ts: Date.now() }],
                }));
              } else if (ev.type === "queue") {
                const live = ev.state === "active";
                const pos = typeof ev.position === "number" ? ev.position : undefined;
                patch(jobId, (j) => ({
                  ...j,
                  status: live ? "running" : "queued",
                  queuePosition: live ? undefined : pos ?? j.queuePosition,
                }));
              } else if (ev.type === "status") {
                const label = String(ev.label || "");
                const hb = !!ev.heartbeat;
                const stillWaiting = /^(Queued|Enqueued)\b/i.test(label);
                steps.push({ kind: "status", label, ts: Date.now() });
                patch(jobId, (j) => {
                  const next = [...j.steps];
                  const last = next[next.length - 1];
                  if (hb && last?.kind === "status" && /still working/i.test(last.label)) {
                    next[next.length - 1] = { kind: "status", label, ts: Date.now() };
                  } else {
                    next.push({ kind: "status", label, ts: Date.now() });
                  }
                  return {
                    ...j,
                    status: stillWaiting ? "queued" : j.status === "queued" ? "running" : j.status,
                    queuePosition: stillWaiting ? j.queuePosition : undefined,
                    steps: next,
                  };
                });
              } else if (ev.type === "text") {
                const full = text + ev.text;
                const vm = full.match(/VERDICT:[^\n]*/i);
                if (vm) verdictLine = vm[0];
                text = full.slice(-8000);
                patch(jobId, (j) => (j.status === "queued" ? { ...j, status: "running", queuePosition: undefined } : j));
                if (!textFlush) textFlush = setTimeout(flushText, 250);
              } else if (ev.type === "done") {
                // finish happens on stream-close; capture the per-run cost it carries
                if (typeof ev.tokens === "number") doneTokens = ev.tokens;
                if (typeof ev.costUsd === "number") doneCostUsd = ev.costUsd;
              } else if (ev.type === "error") {
                finish("error", ev.msg || "Error");
                return;
              }
            } catch {
              /* skip */
            }
          }
        }
        finish("done", "Done");
      } catch {
        // Already settled (or page refresh aborted the reader after Done) —
        // never flip back to running; that caused the Workers refresh loop.
        if (settled) return;
        const cur = jobsRef.current.find((j) => j.id === jobId);
        if (cur?.status === "done" || cur?.status === "error") return;

        // HTTP stream dropped (nav, HMR, idle proxy). The server child often keeps
        // going — reattach instead of banking a false failure.
        const runId = cur?.runId;
        patch(jobId, (j) => ({
          ...j,
          endedAt: undefined,
          steps: [
            ...j.steps,
            { kind: "status", label: "Live log disconnected — reconnecting…", ts: Date.now() },
          ],
        }));
        if (!runId || reconnectDepth >= 3) {
          // Fall back to JSON polling — Score may still be writing the disk snapshot.
          const polled = await pollRunUntilSettled(jobId, runId, meta, patch, jobsRef, (s, label, t, r) =>
            finish(s, label, t, r),
          );
          if (!polled) {
            const hit = await lookupTrackerScore({
              input: meta.input,
              title: meta.title,
              subtitle: meta.subtitle,
            });
            if (hit) {
              finish("done", `Settled from tracker #${hit.n}`, undefined, {
                score: hit.score,
                summary: hit.summary,
                tone: hit.tone,
              });
              return;
            }
            finish(
              "error",
              "Lost live log. Background Score may still finish — check Pipeline/reports, or Retry.",
            );
          }
          return;
        }
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise((r) => setTimeout(r, 800 + attempt * 400));
          const againCur = jobsRef.current.find((j) => j.id === jobId);
          if (againCur?.status === "done" || againCur?.status === "error") return;
          try {
            const again = await fetch(`/api/run?id=${encodeURIComponent(runId)}`);
            if (!again.ok || !again.body) continue;
            patch(jobId, (j) => ({
              ...j,
              status: "running",
              endedAt: undefined,
              steps: [
                ...j.steps,
                { kind: "status", label: "Reattached to worker", ts: Date.now() },
              ],
            }));
            await consume(jobId, meta, again, reconnectDepth + 1);
            return;
          } catch {
            /* try again */
          }
        }
        // SSE gone — poll persisted JSON until done / timeout
        patch(jobId, (j) => ({
          ...j,
          steps: [...j.steps, { kind: "status", label: "Polling saved worker log…", ts: Date.now() }],
        }));
        const polled = await pollRunUntilSettled(jobId, runId, meta, patch, jobsRef, (s, label, t, r) =>
          finish(s, label, t, r),
        );
        if (!polled) {
          const hit = await lookupTrackerScore({
            input: meta.input,
            title: meta.title,
            subtitle: meta.subtitle,
          });
          if (hit) {
            finish("done", `Settled from tracker #${hit.n}`, undefined, {
              score: hit.score,
              summary: hit.summary,
              tone: hit.tone,
            });
            return;
          }
          finish(
            "error",
            "Lost live log. Background Score may still finish — check Pipeline/reports, or Retry.",
          );
        }
      }
    },
    [patch],
  );

  // Restore history once. Do NOT depend on patch/consume — those identities
/**
 * Rebuild one stored job, or discard it (JOBBY-BL-053).
 *
 * localStorage is not a trusted schema: it survives across app versions, and a
 * row written by an older build — or half-written when a tab was killed — can be
 * missing anything. The UI reads `job.steps[job.steps.length - 1]` in three
 * places, so a single entry with no `steps` threw inside render and took the
 * WHOLE app into Next's error boundary: a blank page, on every route, with no way
 * back except clearing site data. Found while testing tenant scoping with
 * deliberately minimal fixtures.
 *
 * Cheaper to make hydration total than to make every consumer defensive.
 */
function reviveJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Partial<Job> & Record<string, unknown>;
  if (typeof j.id !== "string" || !j.id) return null;
  return {
    ...(j as Job),
    steps: Array.isArray(j.steps) ? j.steps : [],
    text: typeof j.text === "string" ? j.text : "",
    status: j.status === "queued" || j.status === "running" || j.status === "error" || j.status === "done"
      ? j.status
      : "done",
  };
}

  // change and used to wipe jobs back to localStorage "running" while skipping
  // heal via `reattached`, which left Workers polling forever.
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    let restored: Job[] = [];
    try {
      const arr = lsReadJson<unknown[]>("jobs", []);
      if (Array.isArray(arr)) restored = arr.map(reviveJob).filter((j): j is Job => j !== null);
    } catch {
      /* ignore */
    }

    // Immediate sync heal: score already in storage → done (no spinner).
    restored = restored.map((job) => {
      if (job.status === "done") return job;
      if (job.result?.score != null) {
        return {
          ...job,
          status: "done" as const,
          endedAt: job.endedAt ?? Date.now(),
          steps: [...(job.steps || []), { kind: "status", label: "Restored finished score", ts: Date.now() }],
        };
      }
      return job;
    });
    setJobs(restored);

    // Restore pending Score queue (survives refresh). Drop URLs already running/done in jobs.
    try {
      const parsed = lsReadJson<{ items?: unknown; paused?: boolean }>("eval-queue", {});
      const items = Array.isArray(parsed.items) ? (parsed.items as StartOpts[]) : [];
      const busy = new Set<string>();
      for (const j of restored) {
        if (j.kind !== "evaluate" || !j.input) continue;
        if (j.status === "error") continue;
        busy.add(j.input);
      }
      const restoredQ = items
        .filter((i) => i && i.kind === "evaluate" && i.input && !busy.has(i.input))
        .slice(0, QUEUE_MAX)
        .map((i) => ({
          title: String(i.title || "Score"),
          subtitle: i.subtitle,
          kind: "evaluate" as const,
          input: String(i.input),
          page: i.page || "/pipeline",
          batchId: i.batchId,
        }));
      if (typeof parsed?.paused === "boolean") setPaused(parsed.paused);
      setQueue(restoredQ);
      // Prune URLs that already landed in the tracker while the tab was closed.
      if (restoredQ.length) {
        void (async () => {
          try {
            const pipe = await fetch("/api/pipeline");
            if (!pipe.ok) return;
            const d = await pipe.json();
            const scored = new Set<string>();
            const apps = Array.isArray(d.applications) ? d.applications : [];
            const reportUrls = Array.isArray(d.reportUrls) ? d.reportUrls : [];
            const byNum = new Map(apps.map((a: { n: string; score?: string }) => [String(parseInt(a.n, 10)), a]));
            for (const { url, n } of reportUrls as { url: string; n: string }[]) {
              const app = byNum.get(String(parseInt(n, 10))) as { score?: string } | undefined;
              const sn = app?.score ? parseFloat(String(app.score)) : NaN;
              if (Number.isFinite(sn)) scored.add(normUrl(url));
            }
            if (!scored.size) return;
            setQueue((q) => q.filter((i) => !scored.has(normUrl(i.input))));
          } catch {
            /* keep full restored queue */
          }
        })();
      }
    } catch {
      /* ignore corrupt queue */
    }
    queueReady.current = true;

    const settleJob = (
      jobId: string,
      status: "done" | "error",
      label: string,
      opts?: { text?: string; result?: JobResult; steps?: JobStep[]; endedAt?: number },
    ) => {
      patch(jobId, (j) => ({
        ...j,
        status,
        result: opts?.result?.score != null ? opts.result : status === "done" ? j.result : j.result,
        text: opts?.text || j.text,
        endedAt: opts?.endedAt || Date.now(),
        steps: [
          ...(opts?.steps && opts.steps.length ? opts.steps : j.steps || []),
          { kind: "status", label, ts: Date.now() },
        ],
      }));
    };

    for (const job of restored) {
      if (job.status === "done") continue;
      if (reattached.current.has(job.id)) continue;
      reattached.current.add(job.id);

      const meta: RunMeta = {
        title: job.title,
        subtitle: job.subtitle,
        page: job.page,
        input: job.input,
        kind: job.kind,
      };
      const runId = job.runId;
      const ageMs = Date.now() - (job.startedAt || Date.now());
      // After a few minutes without a score, prefer tracker over hanging SSE.
      const preferTracker = ageMs > 2 * 60_000;

      (async () => {
        // 1) Saved job JSON / md
        const saved = await loadSavedJob(job.id);
        if (saved && (saved.status === "done" || saved.result?.score != null)) {
          settleJob(job.id, saved.status, "Restored from saved worker log", {
            text: saved.text,
            result: saved.result,
            steps: saved.steps,
            endedAt: saved.endedAt,
          });
          return;
        }

        // 2) Tracker only when stale / no runId — never clobber a live Score with an old row.
        if (job.kind === "evaluate" && (preferTracker || !runId)) {
          const hit = await lookupTrackerScore({
            input: job.input,
            title: job.title,
            subtitle: job.subtitle,
          });
          if (hit) {
            settleJob(job.id, "done", `Restored from tracker #${hit.n}`, {
              result: { score: hit.score, summary: hit.summary, tone: hit.tone },
            });
            return;
          }
        }

        if (!runId) {
          if (job.status === "running" || job.status === "queued") {
            settleJob(job.id, "error", "Interrupted (page reloaded)");
          }
          return;
        }

        // 3) Live SSE only for recent runs — finished hydrates settle consume() quickly.
        if (!preferTracker) {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 8_000);
            const res = await fetch(`/api/run?id=${encodeURIComponent(runId)}`, { signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok && res.body) {
              patch(job.id, (j) => ({ ...j, endedAt: undefined }));
              await consume(job.id, meta, res);
              return;
            }
          } catch {
            /* fall through to poll / tracker */
          }
        }

        // 4) Short disk poll (~20s), then tracker again
        let settled = false;
        const finish = (
          status: "done" | "error",
          lastLabel?: string,
          textOverride?: string,
          resultOverride?: JobResult,
        ) => {
          settled = true;
          settleJob(job.id, status, lastLabel || (status === "done" ? "Done" : "Error"), {
            text: textOverride,
            result: resultOverride,
          });
        };
        const ok = await pollRunUntilSettled(job.id, runId, meta, patch, jobsRef, finish);
        if (ok || settled) return;

        const fromText = parseVerdict(job.text || "");
        if (fromText.score != null) {
          finish("done", "Restored score after refresh", job.text, fromText);
          return;
        }

        if (job.kind === "evaluate") {
          const hit = await lookupTrackerScore({
            input: job.input,
            title: job.title,
            subtitle: job.subtitle,
          });
          if (hit) {
            finish("done", `Restored from tracker #${hit.n}`, undefined, {
              score: hit.score,
              summary: hit.summary,
              tone: hit.tone,
            });
            return;
          }
        }

        // Soft error — Score may still be in Pipeline; don't keep spinning.
        settleJob(
          job.id,
          "error",
          "Live worker log unavailable after refresh. Check Pipeline for a score — Retry only if missing.",
        );
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once; patch/consume via closure
  }, []);

  // Periodic heal: (1) poll disk/BullMQ for running jobs with runId so worker
  // crashes surface without docker logs (BL-010); (2) settle stuck evaluates
  // whose Score already hit the tracker.
  useEffect(() => {
    const tick = async () => {
      const running = jobsRef.current.filter((j) => j.status === "running" || j.status === "queued");

      // Fast path: any runId → /api/runs/poll (includes BullMQ failed state).
      for (const job of running) {
        if (!job.runId) continue;
        try {
          const qs = new URLSearchParams({ runId: job.runId, jobId: job.id, tail: "40" });
          const res = await fetch(`/api/runs/poll?${qs}`);
          if (!res.ok) continue;
          const data = (await res.json()) as PollPayload;
          if (!data.finished) {
            if (data.status === "queued") {
              patch(job.id, (j) => ({
                ...j,
                status: "queued",
                queuePosition: typeof data.queuePosition === "number" ? data.queuePosition : j.queuePosition,
              }));
            } else if (data.status === "running") {
              patch(job.id, (j) => ({ ...j, status: "running", queuePosition: undefined }));
            }
            continue;
          }
          if (data.status === "error") {
            const msg = data.error || "Worker failed";
            patch(job.id, (j) => ({
              ...j,
              status: "error",
              endedAt: Date.now(),
              steps: [...j.steps, { kind: "status", label: msg, ts: Date.now() }],
            }));
            continue;
          }
          const text = String(data.textTail || job.text || "");
          const result = resultFromPoll(data, text);
          patch(job.id, (j) => ({
            ...j,
            status: "done",
            text: text || j.text,
            result: result || j.result,
            endedAt: Date.now(),
            steps: [
              ...j.steps,
              { kind: "status", label: "Done (from worker log)", ts: Date.now() },
            ],
          }));
        } catch {
          /* next tick */
        }
      }

      const stuck = jobsRef.current.filter(
        (j) =>
          j.status === "running" &&
          j.kind === "evaluate" &&
          j.input &&
          Date.now() - (j.startedAt || 0) > 90_000 &&
          j.result?.score == null,
      );
      for (const job of stuck) {
        const saved = await loadSavedJob(job.id);
        if (saved?.result?.score != null) {
          patch(job.id, (j) => ({
            ...j,
            status: "done",
            result: saved.result,
            text: saved.text || j.text,
            endedAt: saved.endedAt || Date.now(),
            steps: [
              ...(j.steps || []).filter((s) => !/polling saved/i.test(s.label)),
              { kind: "status", label: "Settled from saved log", ts: Date.now() },
            ],
          }));
          continue;
        }
        const hit = await lookupTrackerScore({
          input: job.input,
          title: job.title,
          subtitle: job.subtitle,
        });
        if (!hit) continue;
        patch(job.id, (j) => ({
          ...j,
          status: "done",
          result: { score: hit.score, summary: hit.summary, tone: hit.tone },
          endedAt: Date.now(),
          steps: [
            ...(j.steps || []).filter((s) => !/polling saved/i.test(s.label)),
            { kind: "status", label: `Settled from tracker #${hit.n}`, ts: Date.now() },
          ],
        }));
      }
    };
    const id = setInterval(tick, 5_000);
    // Run once shortly after mount so the 4 stuck cards clear without waiting.
    const first = setTimeout(tick, 800);
    return () => {
      clearInterval(id);
      clearTimeout(first);
    };
  }, [patch]);

  const startJob = useCallback(
    (opts: StartOpts): string | null => {
      const id = `job-${Date.now()}-${seq.current++}`;
      const job: Job = {
        id,
        title: opts.title,
        subtitle: opts.subtitle,
        page: opts.page,
        input: opts.input,
        kind: opts.kind,
        batchId: opts.batchId,
        status: "queued",
        steps: [{ kind: "status", label: "Queued — waiting for the dispatcher", ts: Date.now() }],
        text: "",
        startedAt: Date.now(),
      };
      setJobs((js) => [job, ...js]);

      (async () => {
        const { id: cliId, autoPicked, zeroKey } = await resolveCliId();
        if (!cliId) {
          const label = zeroKey
            ? "Scoring runs in your own assistant — connect under Account → MCP"
            : "No CLI configured — open Config";
          patch(id, (j) => ({ ...j, status: "error", endedAt: Date.now(), steps: [...j.steps, { kind: "status", label, ts: Date.now() }] }));
          return;
        }
        // Name it when we chose for you, so the run never silently picks the engine.
        if (autoPicked) {
          patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "status", label: `Using ${cliId}`, ts: Date.now() }] }));
        }

        let res: Response;
        try {
          res = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: opts.kind, input: opts.input, cliId }),
          });
        } catch {
          patch(id, (j) => ({ ...j, status: "error", endedAt: Date.now(), steps: [...j.steps, { kind: "status", label: "Could not reach the server", ts: Date.now() }] }));
          return;
        }
        if (!res.ok || !res.body) {
          const e = await res.json().catch(() => ({}));
          if (res.status === 429 && opts.kind === "evaluate") {
            fairnessHoldUntil.current = Date.now() + 5_000;
            setJobs((js) => js.filter((j) => j.id !== id));
            setQueue((q) => [opts, ...q.filter((x) => x.input !== opts.input)]);
            return;
          }
          patch(id, (j) => ({ ...j, status: "error", endedAt: Date.now(), steps: [...j.steps, { kind: "status", label: e.error || "Failed to start", ts: Date.now() }] }));
          return;
        }
        // Record which run this is BEFORE reading the stream, so even a reload one
        // second later can find its way back to the worker.
        const runId = res.headers.get("X-Run-Id");
        if (runId) patch(id, (j) => ({ ...j, runId }));

        await consume(id, opts, res);
      })();

      return id;
    },
    [patch, consume],
  );
  startJobRef.current = startJob;

  // Cap concurrent evaluate POSTs at the fairness inflight (1 running + 1 waiting).
  // Ollama shares one remote runner (-np 1) — parallel Scores wedge qwen on the M1
  // lab box, so force serial when Config is Ollama.
  const configuredCli = (() => {
    try {
      return String(lsReadJson<{ cliId?: string }>("config", {}).cliId || "");
    } catch {
      return "";
    }
  })();
  const maxConcurrent =
    configuredCli === "ollama" ? MAX_CONCURRENT_OLLAMA : SCORE_INFLIGHT_CAP;
  const runningEval = jobs.filter((j) => j.kind === "evaluate" && (j.status === "running" || j.status === "queued")).length;

  // The pump: whenever a Redis slot frees or the local list/pause state changes,
  // POST as many Scores as fairness allows. startJob adds the job as queued.
  useEffect(() => {
    if (!queueReady.current) return;
    if (Date.now() < fairnessHoldUntil.current) return;
    if (paused || queue.length === 0) return;
    const capacity = maxConcurrent - runningEval;
    if (capacity <= 0) return;
    const batch = queue.slice(0, capacity);
    setQueue((q) => q.slice(batch.length));
    for (const opts of batch) startJobRef.current?.(opts);
  }, [queue, paused, runningEval, maxConcurrent]);

  useEffect(() => {
    const wait = fairnessHoldUntil.current - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => setQueue((q) => q.slice()), wait + 50);
    return () => clearTimeout(t);
  }, [queue, runningEval]);

  const enqueueEvaluate = useCallback((items: StartOpts[]) => {
    setQueue((q) => {
      // Never double-book a posting that's waiting or in-flight. Failed runs are
      // retriable — omit them from the seen set so Retry failed / Score filtered
      // can pick them up again.
      const seen = new Set<string>();
      for (const i of q) if (i.input) seen.add(i.input);
      for (const j of jobsRef.current) {
        if (j.kind !== "evaluate" || !j.input) continue;
        if (j.status === "error") continue;
        seen.add(j.input);
      }
      const add = items.filter((i) => i.input && !seen.has(i.input));
      if (!add.length) return q;
      return [...q, ...add].slice(0, QUEUE_MAX);
    });
  }, []);
  const pauseQueue = useCallback(() => setPaused(true), []);
  const resumeQueue = useCallback(() => setPaused(false), []);
  const clearQueue = useCallback(() => {
    setQueue([]);
    lsRemove("eval-queue");
  }, []);

  const removeJob = useCallback((id: string) => setJobs((js) => js.filter((j) => j.id !== id)), []);
  const clearFinished = useCallback(() => setJobs((js) => js.filter((j) => j.status === "running" || j.status === "queued")), []);

  const pendingQueue: PendingEval[] = queue.map((q) => ({
    title: q.title,
    subtitle: q.subtitle,
    input: q.input,
  }));

  return (
    <JobsContext.Provider
      value={{
        jobs,
        startJob,
        removeJob,
        clearFinished,
        enqueueEvaluate,
        pauseQueue,
        resumeQueue,
        clearQueue,
        queueStats: {
          pending: queue.length,
          running: jobs.filter((j) => j.kind === "evaluate" && j.status === "running").length,
          queued: jobs.filter((j) => j.kind === "evaluate" && j.status === "queued").length,
          paused,
        },
        pendingQueue,
      }}
    >
      {children}
    </JobsContext.Provider>
  );
}
