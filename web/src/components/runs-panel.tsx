"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { JobbyMark, BrandFooter } from "@/components/co-mark";

type Run = {
  jobId: string;
  tenantId: string;
  traceId: string | null;
  kind: string;
  engine: string | null;
  workerId: string | null;
  state: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  tokens: number | null;
  artifactClass: string | null;
  errorClass: string | null;
  states: string[];
  stuck: boolean;
};

type Summary = {
  total: number;
  byState: Record<string, number>;
  stuck: number;
  succeeded: number;
  incomplete: number;
  failed: number;
  medianSuccessMs: number | null;
};

type Payload = { available: boolean; runs: Run[]; summary: Summary; error?: string };

function when(ms: number | null) {
  if (ms == null) return "—";
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function duration(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * The most specific thing known about why a run ended as it did.
 *
 * Order matters: the artifact class names the missing thing, the error class is
 * often just the state again, and the engine is only worth showing when neither
 * of the other two has anything to say.
 */
function reason(r: Run) {
  if (r.artifactClass && r.artifactClass !== "ok") return r.artifactClass;
  if (r.errorClass && r.errorClass !== r.state) return r.errorClass;
  if (r.engine) return `via ${r.engine}`;
  return "—";
}

/**
 * Colour carries the meaning that matters most here: `incomplete` is its own
 * outcome, not a shade of failure. It means the agent exited cleanly and left
 * nothing behind, which is the exact case M7 was built to stop hiding.
 */
const TONE: Record<string, string> = {
  succeeded: "text-emerald-700 dark:text-emerald-400",
  validated: "text-emerald-700 dark:text-emerald-400",
  incomplete: "text-amber-700 dark:text-amber-400",
  failed: "text-red-700 dark:text-red-400",
  timed_out: "text-red-700 dark:text-red-400",
  cancelled: "text-muted",
  running: "text-sky-700 dark:text-sky-400",
  queued: "text-muted",
};

export function RunsPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenantFilter, setTenantFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (tenantId: string) => {
    setLoading(true);
    try {
      const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
      const r = await fetch(`/api/admin/runs${qs}`);
      const body = (await r.json()) as Payload;
      setData(body);
      setError(body.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load runs");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const runs = data?.runs ?? [];
  const s = data?.summary;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <JobbyMark height={56} className="mb-5" />
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Runs</h1>
          <p className="mt-1 text-sm text-muted">
            Every job this instance dispatched, and how it ended. Shape only — the ledger
            holds no URL, CV, report or company name, so nothing here is somebody&apos;s
            job search.
          </p>
        </div>
        <Link
          href="/admin"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-landing"
        >
          <ArrowLeft className="size-3.5" /> Operator
        </Link>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {data && !data.available && !error && (
        <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          The job ledger is unreachable, so this screen cannot tell you whether anything
          ran. That is not the same as nothing having run — check Appwrite before reading
          this as quiet.
        </p>
      )}

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Runs", value: s ? String(s.total) : "—", hint: "in the last 200 events" },
          { label: "Succeeded", value: s ? String(s.succeeded) : "—", hint: s?.medianSuccessMs != null ? `median ${duration(s.medianSuccessMs)}` : "no timings yet" },
          { label: "Incomplete", value: s ? String(s.incomplete) : "—", hint: "ran, produced nothing" },
          { label: "Stuck", value: s ? String(s.stuck) : "—", hint: "no ending recorded" },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-surface/50 p-4">
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted">{card.label}</p>
            <p className="mt-2 font-display text-2xl text-landing">{card.value}</p>
            <p className="mt-1 text-xs text-faint">{card.hint}</p>
          </div>
        ))}
      </section>

      <form
        className="mt-6 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load(tenantFilter.trim());
        }}
      >
        <input
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          placeholder="Filter by tenant id (blank = all)"
          className="min-w-[16rem] flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-landing disabled:opacity-60"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </button>
      </form>

      {data === null ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Reading the ledger…
        </p>
      ) : runs.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          {data.available
            ? "No runs recorded yet. A job appears here the moment the dispatcher queues it."
            : "Nothing to show while the ledger is unreachable."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="bg-surface/60 text-[11px] uppercase tracking-[0.14em] text-muted">
              <tr>
                <th className="px-4 py-2 font-semibold">Started</th>
                <th className="px-4 py-2 font-semibold">Job</th>
                <th className="px-4 py-2 font-semibold">Tenant</th>
                <th className="px-4 py-2 font-semibold">Kind</th>
                <th className="px-4 py-2 font-semibold">Outcome</th>
                <th className="px-4 py-2 font-semibold">Why</th>
                <th className="px-4 py-2 font-semibold">Took</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.jobId} className="border-t border-border">
                  <td className="px-4 py-2 text-muted">{when(r.startedAt)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.jobId}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted">{r.tenantId}</td>
                  <td className="px-4 py-2">{r.kind || "—"}</td>
                  <td className={`px-4 py-2 font-medium ${TONE[r.state] ?? ""}`}>
                    <span className="inline-flex items-center gap-1.5">
                      {r.stuck && <AlertTriangle className="size-3.5 text-amber-600" />}
                      {r.stuck ? `${r.state} · stuck` : r.state}
                    </span>
                  </td>
                  {/* The reason column is the point of the screen: an outcome with
                      no explanation is what M7 replaced. `artifactClass` comes
                      first because it is the specific one — "missing_tracker"
                      tells you where to look, while `errorClass` on an incomplete
                      run is the literal word "incomplete", which just repeats the
                      column to its left. */}
                  <td className="px-4 py-2 text-xs text-muted">{reason(r)}</td>
                  <td className="px-4 py-2 text-muted">{duration(r.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-xs leading-relaxed text-faint">
        A run is <strong>incomplete</strong> when the agent exited cleanly and the tenant&apos;s
        files did not gain what the job promised — the dispatcher checks the files, never the
        agent&apos;s own claim. <strong>Stuck</strong> means no ending was ever recorded: the
        job outlived even the sandbox&apos;s own timeout, so the dispatcher itself is the thing
        to look at.
      </p>

      <BrandFooter className="mt-12 border-t border-border pt-6" />
    </div>
  );
}
