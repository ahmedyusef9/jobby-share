"use client";

import { use, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X, RotateCcw, Settings, ExternalLink } from "lucide-react";
import { useJobs, queuedCaption } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";
import { ApplyButton } from "@/components/apply-button";
import { SaveCvButton, ViewCvLink } from "@/components/save-cv-button";
import { JobInfoPanel, CopyJobUrl } from "@/components/job-info-panel";
import { extractCvPdfPath } from "@/lib/download-cv";
import { humanizeStep } from "@/components/jobs/worker-card";
import { normUrl } from "@/lib/format";
import type { Application } from "@/lib/career-ops";

/** Resolve tracker row + posting URL for evaluate (input=URL) or pdf (input=#). */
function resolveTrackerMatch(
  job: { kind?: string; input?: string; title: string; subtitle?: string },
  apps: Application[],
  reportUrls: { url: string; n: string }[],
): { app: Application | null; url: string | null } {
  const byNum = new Map(apps.map((a) => [String(parseInt(a.n, 10)), a]));
  const urlByN = new Map<string, string>();
  for (const { url, n } of reportUrls) {
    const num = String(parseInt(n, 10));
    if (!Number.isNaN(parseInt(n, 10)) && url) urlByN.set(num, url);
  }

  // PDF / research workers store application # as input — not the job URL.
  if (job.kind === "pdf" || (job.input && /^\d+$/.test(job.input.trim()))) {
    const num = String(parseInt(job.input || "", 10));
    const app = byNum.get(num) || null;
    return { app, url: urlByN.get(num) || null };
  }

  if (job.kind === "evaluate" && job.input) {
    const want = normUrl(job.input);
    let best: Application | null = null;
    let bestN = -1;
    for (const { url, n } of reportUrls) {
      if (normUrl(url) !== want) continue;
      const num = parseInt(n, 10);
      if (Number.isNaN(num) || num < bestN) continue;
      const app = byNum.get(String(num));
      if (app) {
        best = app;
        bestN = num;
      }
    }
    if (!best) {
      const company = job.title.replace(/^Score\s*·\s*/i, "").trim().toLowerCase();
      const role = (job.subtitle || "").toLowerCase();
      best =
        apps.find(
          (a) =>
            a.company.toLowerCase() === company &&
            (!role || a.role.toLowerCase().includes(role) || role.includes(a.role.toLowerCase())),
        ) || null;
    }
    const url =
      (best && urlByN.get(String(parseInt(best.n, 10)))) ||
      (/^https?:\/\//i.test(job.input) ? job.input : null);
    return { app: best, url };
  }

  if (job.input && /^https?:\/\//i.test(job.input)) {
    return { app: null, url: job.input };
  }
  return { app: null, url: null };
}

function useElapsed(running: boolean, startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, startedAt]);
  return Math.max(0, now - startedAt);
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Strip a duplicated VERDICT suffix that sometimes lands in the one-line summary. */
function cleanSummary(summary: string): string {
  return summary.replace(/\s*VERDICT:\s*[\d.]+\s*\/\s*5[^\n]*/i, "").trim();
}

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs, startJob, enqueueEvaluate } = useJobs();
  const job = jobs.find((j) => j.id === id);
  const elapsed = useElapsed(job?.status === "running", job?.startedAt ?? Date.now());
  // Defer heavy markdown so the header / activity stay readable while tokens stream.
  const deferredText = useDeferredValue(job?.text ?? "");
  const logRef = useRef<HTMLOListElement>(null);
  const followLive = useRef(true);
  const [trackerApp, setTrackerApp] = useState<Application | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [savePrompt, setSavePrompt] = useState(false);
  const savePromptedFor = useRef<string | null>(null);
  // BL-092/BL-094: a member's browser can only reach an evaluate-kind job here
  // from before host Score was gated off (legacy history, a demoted operator
  // account) — Retry must not resurrect it. PDF/research retries stay open.
  const [isOperator, setIsOperator] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { role?: string; operator?: boolean } | null) => {
        if (!cancelled && (d?.operator || d?.role === "operator")) setIsOperator(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const steps = job?.steps ?? [];
  // Cap painted activity rows while running — full list once settled.
  const visibleSteps = useMemo(() => {
    if (!job || job.status !== "running" || steps.length <= 40) return steps;
    return steps.slice(-40);
  }, [job, steps]);

  useEffect(() => {
    if (!followLive.current || job?.status !== "running") return;
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [visibleSteps.length, job?.status]);

  // When a PDF worker finishes, offer Save As once (browsers need a click for the folder picker).
  useEffect(() => {
    if (!job || job.kind !== "pdf" || job.status !== "done") return;
    if (savePromptedFor.current === job.id) return;
    savePromptedFor.current = job.id;
    setSavePrompt(true);
  }, [job?.id, job?.kind, job?.status]);

  // Resolve tracker row + posting URL for evaluate (URL input) and pdf (# input).
  useEffect(() => {
    if (!job || (job.status !== "done" && job.status !== "running" && job.status !== "queued" && job.status !== "error")) {
      setTrackerApp(null);
      setResolvedUrl(null);
      return;
    }
    // Need something to resolve from
    if (!job.input && job.kind !== "pdf" && job.kind !== "evaluate") {
      setTrackerApp(null);
      setResolvedUrl(job.input && /^https?:\/\//i.test(job.input) ? job.input : null);
      return;
    }
    let alive = true;
    fetch("/api/pipeline")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        const apps = (Array.isArray(d.applications) ? d.applications : []) as Application[];
        const reportUrls = (Array.isArray(d.reportUrls) ? d.reportUrls : []) as { url: string; n: string }[];
        const { app, url } = resolveTrackerMatch(job, apps, reportUrls);
        setTrackerApp(app);
        setResolvedUrl(url);
      })
      .catch(() => {
        if (alive) {
          setTrackerApp(null);
          setResolvedUrl(job.input && /^https?:\/\//i.test(job.input) ? job.input : null);
        }
      });
    return () => {
      alive = false;
    };
  }, [job?.id, job?.status, job?.kind, job?.input, job?.title, job?.subtitle]);

  if (!job) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
            <ArrowLeft className="size-4" /> Workers
          </Link>
          <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
            Pipeline
          </Link>
        </div>
        <p className="mt-8 text-sm text-muted">
          This worker is no longer in memory (it finished earlier or was cleared).
        </p>
      </div>
    );
  }

  const canRetry =
    job.status === "error" &&
    !!job.input &&
    (job.kind === "pdf" || job.kind === "research" || job.kind === "test-portal" || (job.kind === "evaluate" && isOperator));

  const lastStep = job.steps[job.steps.length - 1]?.label || "";
  const quotaHint = /out of usage credits|credits_required|usage limit/i.test(`${lastStep} ${job.text}`);
  const liveLabel = lastStep ? humanizeStep(lastStep) : "Waiting for the agent to start…";
  const postingUrl =
    resolvedUrl ||
    (job.input && /^https?:\/\//i.test(job.input) ? job.input : null);
  const truncatedLog = job.status === "running" && steps.length > visibleSteps.length;
  const summary = job.result?.summary ? cleanSummary(job.result.summary) : "";
  const pdfReady = !!trackerApp && /✅|✓|yes|true/i.test(trackerApp.pdf || "");
  const companyFromTitle = job.title.replace(/^CV PDF\s*·\s*/i, "").replace(/^Score\s*·\s*/i, "").trim();
  const companyLabel = trackerApp?.company || companyFromTitle;
  const roleLabel = trackerApp?.role || job.subtitle || "";
  const appN = trackerApp?.n || (job.kind === "pdf" && job.input && /^\d+$/.test(job.input) ? job.input : null);
  const cvPath =
    job.kind === "pdf"
      ? extractCvPdfPath(`${summary} ${job.text || ""}`)
      : null;
  const summaryDisplay = cvPath
    ? summary.replace(cvPath, "").replace(/\*+/g, "").replace(/\s{2,}/g, " ").trim()
    : summary;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
          <ArrowLeft className="size-4" /> Workers
        </Link>
        <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
          Pipeline
        </Link>
      </div>

      {/* Save-as prompt when a tailored CV just finished */}
      {savePrompt && job.kind === "pdf" && job.status === "done" && (
        <div
          role="dialog"
          aria-label="CV ready"
          className="fixed inset-x-0 bottom-0 z-50 border-t border-emerald-500/30 bg-surface/95 p-4 shadow-lg backdrop-blur sm:inset-x-auto sm:bottom-6 sm:left-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:rounded-2xl sm:border"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-landing">CV ready — choose where to save</p>
              {(companyLabel || roleLabel) && (
                <p className="mt-1 text-xs text-muted">
                  <span className="font-medium text-foreground">{companyLabel}</span>
                  {roleLabel ? ` · ${roleLabel}` : ""}
                  {appN ? ` · #${appN}` : ""}
                </p>
              )}
              {postingUrl && (
                <a
                  href={postingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 flex max-w-full items-center gap-1.5 text-[11px] text-brand hover:underline"
                  title={postingUrl}
                >
                  <ExternalLink className="size-3 shrink-0" />
                  <span className="truncate">{postingUrl}</span>
                </a>
              )}
              {cvPath && (
                <p className="mt-0.5 truncate font-mono text-[11px] text-faint" title={cvPath}>
                  {cvPath}
                </p>
              )}
              <p className="mt-1 text-[11px] text-muted">
                Repo copy stays in <code className="text-faint">output/</code>. Save PDF… opens a folder picker
                (Chrome/Edge) or Downloads (Safari/Firefox).
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <SaveCvButton
                company={companyLabel}
                file={cvPath}
                suggestedName={cvPath?.split("/").pop()}
                variant="primary"
                label="Save PDF…"
              />
              <ViewCvLink company={companyLabel} file={cvPath} />
              {postingUrl && <CopyJobUrl url={postingUrl} />}
              <button
                type="button"
                onClick={() => setSavePrompt(false)}
                className="rounded-full px-3 py-2 text-xs text-muted hover:text-foreground max-sm:min-h-[44px]"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {job.status === "running" && <HeroGlow />}
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {job.status === "running" ? (
              <>
                <Loader2 className="size-3 animate-spin text-brand" /> evaluating · {fmtElapsed(elapsed)}
              </>
            ) : job.status === "queued" ? (
              <>
                <Loader2 className="size-3 text-muted" /> {queuedCaption(job).toLowerCase()}
              </>
            ) : job.status === "done" ? (
              <>
                <Check className="size-3 text-emerald-500" /> done
              </>
            ) : (
              <>
                <X className="size-3 text-red-400" /> error
              </>
            )}
          </p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{job.title}</h1>
          {job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>}
          {job.status === "queued" && <p className="mt-3 text-sm text-muted">{queuedCaption(job)}</p>}
          {job.status === "running" && <p className="mt-3 text-sm text-brand">{liveLabel}</p>}
          {job.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
              {summaryDisplay && <span className="text-sm text-muted">{summaryDisplay}</span>}
            </div>
          )}

          {/* Shared Job info — same panel as /pipeline/[n] and /pipeline/open */}
          {(trackerApp || postingUrl || appN) && (
            <div className="mt-4">
              <JobInfoPanel
                company={companyLabel}
                role={roleLabel}
                appN={appN}
                score={trackerApp?.score}
                status={trackerApp?.status}
                url={postingUrl}
                pdfReady={pdfReady || (job.kind === "pdf" && job.status === "done")}
                showTrackerActions={job.status === "done" && job.kind === "evaluate" && !!trackerApp}
                showPipelineLink
                footer={
                  job.status === "done" && job.kind === "pdf" ? (
                    <div className="space-y-3">
                      {cvPath && (
                        <p className="font-mono text-xs text-muted">
                          Path:{" "}
                          <a
                            href={`/api/cv-pdf?file=${encodeURIComponent(cvPath)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand hover:underline"
                          >
                            {cvPath}
                          </a>
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <SaveCvButton
                          company={companyLabel}
                          file={cvPath}
                          suggestedName={cvPath?.split("/").pop()}
                          variant="primary"
                          label="Save PDF…"
                        />
                        <ViewCvLink company={companyLabel} file={cvPath} />
                        {trackerApp && (
                          <ApplyButton
                            n={trackerApp.n}
                            url={postingUrl || undefined}
                            company={trackerApp.company}
                            pdfReady={pdfReady || job.status === "done"}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => setSavePrompt(true)}
                          className="text-xs text-muted hover:text-brand max-sm:min-h-[44px]"
                        >
                          Show save prompt
                        </button>
                      </div>
                    </div>
                  ) : job.status === "done" && job.kind === "evaluate" && !trackerApp ? (
                    <p className="text-xs text-faint">
                      Tracker row not found yet — open{" "}
                      <Link href="/pipeline?tab=EVALUATED" className="text-brand hover:underline">
                        Pipeline → Evaluated
                      </Link>{" "}
                      to set status.
                    </p>
                  ) : null
                }
              />
            </div>
          )}

          {canRetry && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const opts = {
                    title: job.title,
                    subtitle: job.subtitle,
                    kind: job.kind || "evaluate",
                    input: job.input!,
                    page: job.page || "/pipeline",
                  };
                  if (opts.kind === "evaluate") enqueueEvaluate([opts]);
                  else startJob(opts);
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
              >
                <RotateCcw className="size-3.5" /> Retry score
              </button>
              <Link
                href="/config"
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
              >
                <Settings className="size-3.5" />
                {quotaHint ? "Switch CLI / model in Config" : "Config"}
              </Link>
            </div>
          )}
          {quotaHint && (
            <p className="mt-3 text-xs text-amber-800 dark:text-amber-200">
              This model is out of credits. In Config, pick an engine that shows Live OK (or set JOBBY_CURSOR_MODEL /
              JOBBY_CLAUDE_MODEL), then Retry.
            </p>
          )}
        </div>
      </section>

      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Activity</h2>
          {truncatedLog && (
            <span className="text-[11px] text-faint">showing last {visibleSteps.length} of {steps.length}</span>
          )}
        </div>
        <ol
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            followLive.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="mt-3 max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border/60 bg-surface/20 p-3"
        >
          {visibleSteps.map((s, i) => (
            <li key={`${s.ts}-${i}`} className="flex items-start gap-2.5 text-sm">
              {s.kind === "tool" ? (
                <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand" />
              ) : (
                <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />
              )}
              <span className={s.kind === "tool" ? "font-medium" : "text-muted"}>{humanizeStep(s.label)}</span>
            </li>
          ))}
          {job.status === "running" && (
            <li className="flex items-center gap-2.5 text-sm text-muted">
              <Loader2 className="size-3.5 animate-spin text-brand" />
              {liveLabel} · {fmtElapsed(elapsed)}
            </li>
          )}
        </ol>
      </div>

      {deferredText && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            Output{job.status === "running" ? " · live" : ""}
          </h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{deferredText}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
