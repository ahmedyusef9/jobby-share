"use client";

import { memo, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, AlertTriangle, Loader2, Trash2, ArrowLeft } from "lucide-react";
import { useJobs, type Job, queuedCaption } from "@/components/jobs/job-store";
import { pillTone } from "@/components/jobs/worker-pills";
import { humanizeStep } from "@/components/jobs/worker-card";
import { cn } from "@/lib/cn";

const TONE_CHIP = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/15 text-red-700 dark:text-red-400",
  muted: "bg-surface-hover text-muted",
} as const;

type QueueSnap = {
  queueEnabled: boolean;
  counts?: { waiting: number; active: number; failed: number };
  recentFailed?: { id: string; kind?: string; reason: string }[];
  error?: string;
};

function QueueHealthBanner() {
  const [snap, setSnap] = useState<QueueSnap | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/queue")
        .then((r) => r.json())
        .then((d: QueueSnap) => {
          if (!cancelled) setSnap(d);
        })
        .catch(() => {
          if (!cancelled) setSnap(null);
        });
    };
    load();
    const t = setInterval(load, 8_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!snap?.queueEnabled) return null;
  const failed = snap.counts?.failed || 0;
  const recent = snap.recentFailed?.[0];
  if (failed === 0 && !snap.error) {
    return (
      <p className="mt-4 text-xs text-muted">
        Queue · waiting {snap.counts?.waiting ?? 0} · active {snap.counts?.active ?? 0}
      </p>
    );
  }
  return (
    <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">
            Worker queue · {failed} failed{snap.error ? ` · ${snap.error}` : ""}
          </p>
          {recent && (
            <p className="mt-1 truncate text-xs opacity-90">
              Latest: {recent.kind || "job"} · {recent.reason}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const WorkerRow = memo(function WorkerRow({ job }: { job: Job }) {
  const tone = pillTone(job);
  const last = job.steps[job.steps.length - 1]?.label;
  const subtitle =
    job.status === "running"
      ? last
        ? humanizeStep(last)
        : "Evaluating…"
      : job.status === "queued"
        ? queuedCaption(job)
      : job.status === "error"
        ? last || job.subtitle || "Worker failed"
        : job.result?.summary || job.subtitle;

  return (
    <li>
      <Link href={`/jobs/${job.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover">
        {job.status === "running" ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
        ) : job.status === "queued" ? (
          <Loader2 className="size-4 shrink-0 text-muted" />
        ) : job.status === "error" ? (
          <AlertTriangle className="size-4 shrink-0 text-red-400" />
        ) : (
          <Check className="size-4 shrink-0 text-emerald-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{job.title}</div>
          {subtitle && (
            <div className={cn("truncate text-xs", job.status === "error" ? "text-red-600 dark:text-red-400" : "text-muted")}>
              {subtitle}
            </div>
          )}
        </div>
        {job.result?.score != null && (
          <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums", TONE_CHIP[tone])}>
            {job.result.score}/5
          </span>
        )}
        <span className="hidden shrink-0 text-xs capitalize text-faint sm:block">{job.status}</span>
      </Link>
    </li>
  );
});

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {title} <span className="tabular-nums text-faint">· {count}</span>
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">{children}</ul>
    </section>
  );
}

export default function JobsHistory() {
  // BL-094 REQ-NV-002: operator-only chrome, 404 rather than 403 for a member
  // so the page does not confirm this destination exists. Client component
  // (reads the local job store), so this is a client-side check — fail
  // closed (render nothing) until confirmed, never flash the list to a member.
  const [access, setAccess] = useState<"loading" | "operator" | "member">("loading");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { role?: string; operator?: boolean } | null) => {
        if (cancelled) return;
        setAccess(d?.operator || d?.role === "operator" ? "operator" : "member");
      })
      .catch(() => {
        if (!cancelled) setAccess("member");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { jobs, clearFinished } = useJobs();
  const { running, queued, finished } = useMemo(() => {
    const r: Job[] = [];
    const q: Job[] = [];
    const f: Job[] = [];
    for (const j of jobs) {
      if (j.status === "running") r.push(j);
      else if (j.status === "queued") q.push(j);
      else f.push(j);
    }
    return { running: r, queued: q, finished: f };
  }, [jobs]);

  if (access === "loading") return null;
  if (access === "member") notFound();

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href="/pipeline"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
      >
        <ArrowLeft className="size-4" /> Pipeline
      </Link>
      <div className="mt-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Workers</h1>
          <p className="mt-1 text-sm text-muted">
            All Score / PDF / research runs on this machine ({jobs.length} in memory). Open a row for activity + output.
          </p>
        </div>
        {finished.length > 0 && (
          <button
            type="button"
            onClick={clearFinished}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground max-sm:min-h-[44px]"
          >
            <Trash2 className="size-3.5" /> Clear finished
          </button>
        )}
      </div>

      <QueueHealthBanner />

      {jobs.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center text-sm text-muted">
          No workers yet. Hit <span className="text-foreground">Score</span> on Pipeline to spin one up.
        </div>
      ) : (
        <>
          <Section title="Queued" count={queued.length}>
            {queued.map((j) => (
              <WorkerRow key={j.id} job={j} />
            ))}
          </Section>
          <Section title="Running" count={running.length}>
            {running.map((j) => (
              <WorkerRow key={j.id} job={j} />
            ))}
          </Section>
          <Section title="Finished" count={finished.length}>
            {finished.map((j) => (
              <WorkerRow key={j.id} job={j} />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
