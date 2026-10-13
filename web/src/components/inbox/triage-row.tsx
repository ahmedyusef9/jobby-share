"use client";

import { Bookmark, BookmarkCheck, Loader2, X, ExternalLink } from "lucide-react";
import type { InboxJob } from "@/lib/career-ops";
import type { AtsSource } from "@/lib/explore";
import { ATS_LABEL } from "@/lib/explore";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { cn } from "@/lib/cn";

// A row's score can come from a live worker (jobId) OR a persisted tracker row
// (n = report number) — the latter is what survives a reload. `running` / `queued`
// / `error` drive the right-rail status (not only a finished A–F badge).
export type RowScore = {
  score: number | null;
  tone: "good" | "warn" | "bad" | "muted";
  running: boolean;
  queued?: boolean;
  queuePosition?: number;
  error?: boolean;
  jobId?: string;
  n?: string;
};

function agoLabel(age: number | null): string | null {
  if (age == null) return null;
  if (age <= 0) return "today";
  if (age === 1) return "yesterday";
  if (age < 7) return `${age}d ago`;
  if (age < 30) return `${Math.floor(age / 7)}w ago`;
  return `${Math.floor(age / 30)}mo ago`;
}

/** Published date from scan first_seen (YYYY-MM-DD) + relative age. */
function publishedLabel(postedAt: string | undefined, age: number | null): string | null {
  if (postedAt && /^\d{4}-\d{2}-\d{2}$/.test(postedAt)) {
    const rel = agoLabel(age);
    return rel ? `${postedAt} · ${rel}` : postedAt;
  }
  return agoLabel(age);
}

// One raw posting in the triage list. Row click opens the role page
// (/pipeline/[n] or /pipeline/open — same JobInfoPanel as Workers). Checkbox
// (multi-select) and Shortlist/Skip stop propagation. Real A–F badge once scored.
export function TriageRow({
  job,
  source,
  age,
  scored,
  fit,
  fitHits,
  profileLabel,
  selected,
  active,
  shortlisted,
  selectable = true,
  onSelect,
  onToggleSelect,
  onSave,
  onSkip,
}: {
  job: InboxJob;
  source: AtsSource | null;
  age: number | null;
  scored?: RowScore;
  /** Keyword-fit hits vs portals/profile — only when Most match sort is on. */
  fit?: number;
  fitHits?: string[];
  /** M2 search-profile label for this row (title), if it was tagged by a profile. */
  profileLabel?: string;
  selected: boolean;
  active: boolean;
  shortlisted: boolean;
  /** False when already scored — checkbox disabled so it can't join a batch. */
  selectable?: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const ago = publishedLabel(job.postedAt, age);
  const hasStatus =
    !!scored && (scored.running || scored.queued || scored.error || scored.score != null);

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 px-3 py-2.5 transition-colors sm:gap-3 sm:px-4",
        active ? "bg-brand-soft" : selected ? "bg-brand-soft/50" : "hover:bg-surface-hover",
      )}
    >
      {/* multi-select — only unscored / failed join Score selected */}
      <input
        type="checkbox"
        checked={selected}
        disabled={!selectable}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggleSelect}
        aria-label={`Select ${job.company} ${job.role}`}
        title={
          selectable
            ? undefined
            : "Already scored — still selectable for shortlist; Score selected skips it"
        }
        className="size-4 shrink-0 accent-brand disabled:cursor-not-allowed disabled:opacity-40 max-sm:min-h-[44px] max-sm:min-w-[24px]"
      />

      <CompanyLogo name={job.company} size={20} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-medium text-foreground">{job.company}</span>
          <span className="text-muted"> · {job.role}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
          {job.location && <span className="truncate">{job.location}</span>}
          {profileLabel && (
            <span className="rounded bg-brand/10 px-1 py-px font-medium text-brand" title={job.profileId}>
              {profileLabel}
            </span>
          )}
          {source && <span className="rounded bg-surface-hover px-1 py-px font-medium text-muted">{ATS_LABEL[source]}</span>}
          {job.url && /^https?:\/\//i.test(job.url) && (
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-0.5 text-brand hover:underline"
              title={job.url}
            >
              posting <ExternalLink className="size-2.5" />
            </a>
          )}
          {/* honest "not scored" — no fabricated match%. */}
          {!hasStatus && <span className="italic text-muted">not scored</span>}
          {scored?.queued && !scored.running && <span className="text-muted">in queue</span>}
          {typeof fit === "number" && (
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                fit > 0
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                  : "border-border text-faint",
              )}
              title={
                fitHits?.length
                  ? `Keyword fit (not A–F): ${fitHits.join(", ")}`
                  : "No overlap with portals/profile target keywords"
              }
            >
              fit {fit}
            </span>
          )}
        </p>
      </div>

      {/* Posted / first-seen — dedicated column so you can scan + sort by it */}
      <div
        className="hidden w-[6.5rem] shrink-0 flex-col items-end text-right sm:flex"
        title={job.postedAt ? `Posted / first seen ${job.postedAt}` : "No posting date in scan history"}
      >
        {ago ? (
          <>
            <span className="text-[11px] font-medium tabular-nums text-foreground">
              {job.postedAt && /^\d{4}-\d{2}-\d{2}$/.test(job.postedAt) ? job.postedAt.slice(5) : ago}
            </span>
            <span className="text-[10px] text-faint">{job.postedAt ? agoLabel(age) : "no date"}</span>
          </>
        ) : (
          <span className="text-[10px] text-faint">no date</span>
        )}
      </div>
      {/* mobile: keep date inline under title */}
      {ago && (
        <span className="shrink-0 text-[10px] tabular-nums text-faint sm:hidden" title={job.postedAt}>
          {ago}
        </span>
      )}

      {/* Score / queue / error state (right-aligned) */}
      {hasStatus ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs">
          {scored!.running ? (
            <>
              <Loader2 className="size-3.5 animate-spin text-brand" />
              <span className="text-brand max-sm:hidden">Evaluating…</span>
            </>
          ) : scored!.error && scored!.score == null ? (
            <span className="font-medium text-red-500">Failed</span>
          ) : scored!.queued ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted">
              {scored!.queuePosition != null ? `Queued (position #${scored!.queuePosition})` : "Queued"}
            </span>
          ) : scored!.score != null ? (
            <Badge tone={scored!.tone}>{scored!.score}/5</Badge>
          ) : null}
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSave();
            }}
            title={shortlisted ? "In shortlist tray (bottom) — not Applied" : "Add to shortlist tray to score later — not Applied"}
            aria-pressed={shortlisted}
            className={cn(
              "inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px] max-sm:min-w-[44px]",
              shortlisted ? "text-brand" : "text-muted hover:bg-surface-hover hover:text-brand",
            )}
          >
            {shortlisted ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
            <span className="max-sm:hidden">{shortlisted ? "Shortlisted" : "Shortlist"}</span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSkip();
            }}
            title="Skip — hide from the inbox"
            className="inline-flex items-center justify-center rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </li>
  );
}
