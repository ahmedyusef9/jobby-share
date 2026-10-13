"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { CheckCheck, Copy, ExternalLink } from "lucide-react";
import { StatusSelect } from "@/components/status-select";
import { GeneratePdfButton } from "@/components/generate-pdf-button";
import { ApplyButton } from "@/components/apply-button";
import { rolePageHref } from "@/lib/role-href";

/** Copy posting URL — shared by Workers, report page, and inbox open page. */
export function CopyJobUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy job URL"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
    >
      {copied ? <CheckCheck className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy URL"}
    </button>
  );
}

/**
 * Single Job info + tracker actions block used by Workers, /pipeline/[n], and
 * /pipeline/open. Do not re-implement Status / PDF / Apply / URL copy elsewhere.
 */
export function JobInfoPanel({
  company,
  role,
  appN,
  score,
  status,
  url,
  pdfReady = false,
  showTrackerActions = true,
  showPipelineLink = false,
  /** Hide Report # / Full report when this panel already lives on that page */
  onReportPage = false,
  reportLinkLabel = "Full report",
  footer,
}: {
  company: string;
  role?: string;
  appN?: string | null;
  score?: string | null;
  status?: string | null;
  url?: string | null;
  pdfReady?: boolean;
  /** StatusSelect + Generate CV + Apply — needs a tracker # */
  showTrackerActions?: boolean;
  /** Extra “back to list” style link (Workers only; report page is already there) */
  showPipelineLink?: boolean;
  onReportPage?: boolean;
  reportLinkLabel?: string;
  /** Unscored CTAs (Score / Mark Applied) or other actions under the card */
  footer?: ReactNode;
}) {
  const postingUrl = url && /^https?:\/\//i.test(url) ? url : null;
  const hasApp = !!appN;

  return (
    <div className="space-y-2.5 rounded-xl border border-border/70 bg-background/50 p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Job info</p>
        {hasApp && !onReportPage && (
          <Link href={rolePageHref({ n: appN })} className="text-[11px] text-brand hover:underline">
            Report #{appN}
          </Link>
        )}
        {hasApp && onReportPage && (
          <span className="text-[11px] tabular-nums text-faint">Report #{appN}</span>
        )}
      </div>

      {(company || role) && (
        <p className="text-sm text-landing">
          <span className="font-medium">{company || "—"}</span>
          {role ? <span className="text-muted"> · {role}</span> : null}
        </p>
      )}

      {(score || status) && (
        <p className="text-xs text-muted">
          {score ? `Tracker score ${score}` : null}
          {score && status ? " · " : null}
          {status || null}
        </p>
      )}

      {postingUrl ? (
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={postingUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm text-brand hover:underline max-sm:min-h-[44px]"
            title={postingUrl}
          >
            <ExternalLink className="size-3.5 shrink-0" />
            <span className="truncate">{postingUrl}</span>
          </a>
          <CopyJobUrl url={postingUrl} />
        </div>
      ) : (
        <p className="text-xs text-faint">No posting URL on file.</p>
      )}

      {(hasApp && !onReportPage) || showPipelineLink ? (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {hasApp && !onReportPage && (
            <Link
              href={rolePageHref({ n: appN })}
              className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-brand max-sm:min-h-[44px]"
            >
              {reportLinkLabel} <ExternalLink className="size-3" />
            </Link>
          )}
          {showPipelineLink && (
            <Link
              href="/pipeline?tab=INBOX"
              className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-brand max-sm:min-h-[44px]"
            >
              Pipeline inbox
            </Link>
          )}
        </div>
      ) : null}

      {showTrackerActions && hasApp && (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-border/60 pt-3">
          {status != null && <StatusSelect n={String(appN)} current={status} />}
          <GeneratePdfButton n={String(appN)} company={company} pdfReady={pdfReady} />
          <ApplyButton
            n={String(appN)}
            url={postingUrl || undefined}
            company={company}
            pdfReady={pdfReady}
          />
        </div>
      )}

      {footer ? <div className="border-t border-border/60 pt-3">{footer}</div> : null}
    </div>
  );
}
