"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { jobIsLive, queuedCaption, useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import { SaveCvButton, ViewCvLink } from "@/components/save-cv-button";
import { extractCvPdfPath } from "@/lib/download-cv";

// Fires the real career-ops `pdf` mode (worker kind "pdf") to generate an
// ATS-optimized CV tailored to THIS offer → output/cv-… + marks the tracker.
// Once ready: View + Save As (OS folder picker when the browser supports it).
export function GeneratePdfButton({ n, company, pdfReady }: { n: string; company: string; pdfReady: boolean }) {
  const { jobs, startJob } = useJobs();
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "pdf" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const generate = () =>
    startJob({ title: `CV PDF · ${company}`, subtitle: "tailored for this role", kind: "pdf", input: n, page: `/pipeline/${n}` });

  const file =
    job?.status === "done"
      ? extractCvPdfPath(`${job.result?.summary || ""} ${job.text || ""}`)
      : null;

  if (job && jobIsLive(job))
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]">
        {job.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <Loader2 className="size-3.5" />}
        {job.status === "queued" ? queuedCaption(job) : "Generating CV…"}
      </Link>
    );

  if (job?.status === "error") {
    const reason = job.steps[job.steps.length - 1]?.label || "PDF worker failed";
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Link
          href={`/jobs/${job.id}`}
          className="inline-flex max-w-[16rem] items-center justify-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-700 dark:text-red-300 max-sm:min-h-[44px]"
          title={reason}
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="truncate">CV failed — details</span>
        </Link>
        <button
          type="button"
          onClick={generate}
          title="Retry PDF generation"
          className="inline-flex items-center justify-center rounded-full p-1 text-faint transition-colors hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]"
        >
          <RotateCcw className="size-3" />
        </button>
      </span>
    );
  }

  const ready = pdfReady || job?.status === "done";
  if (ready)
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <ViewCvLink company={company} file={file} />
        <SaveCvButton company={company} file={file} label="Save PDF…" />
        <button
          onClick={generate}
          title="Regenerate the tailored CV"
          className="inline-flex items-center justify-center rounded-full p-1 text-faint transition-colors hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]"
        >
          <RotateCcw className="size-3" />
        </button>
      </span>
    );

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={generate}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
        title="Generate an ATS-optimized CV tailored to this role"
      >
        Generate tailored CV (PDF)
      </button>
      <CostBadge kind="spend" size="xs" />
    </span>
  );
}
