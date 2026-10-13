"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Loader2, Radar, Settings, Sparkles, X } from "lucide-react";
import { JobInfoPanel } from "@/components/job-info-panel";
import { CostBadge } from "@/components/cost/cost-badge";
import { useJobs } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { CompanyLogo } from "@/components/company-logo";
import { Badge } from "@/components/ui/badge";
import type { Application, InboxJob, ScanHit } from "@/lib/career-ops";
import { scoreTone } from "@/lib/format";
import { rolePageHref } from "@/lib/role-href";
import { lsReadJson } from "@/lib/storage";

type TrackStatus = "Applied" | "Discarded" | "SKIP";

function OpenRoleInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { enqueueEvaluate } = useJobs();
  const url = (params.get("url") || "").trim();
  const companyQ = (params.get("company") || "").trim();
  const roleQ = (params.get("role") || "").trim();
  const forceScore = params.get("forceScore") === "1";

  const [app, setApp] = useState<Application | null>(null);
  const [scan, setScan] = useState<ScanHit | null>(null);
  const [inboxJob, setInboxJob] = useState<InboxJob | null>(null);
  const [inPipeline, setInPipeline] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState(url);
  const [company, setCompany] = useState(companyQ);
  const [role, setRole] = useState(roleQ);
  const [location, setLocation] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasCli, setHasCli] = useState(false);
  // Zero-key members (BL-058): the score CTA points at MCP, not Config.
  const [zeroKey, setZeroKey] = useState(false);
  const [tracking, setTracking] = useState<TrackStatus | null>(null);
  const [trackErr, setTrackErr] = useState<string | null>(null);

  useEffect(() => {
    const c = lsReadJson<{ cliId?: string }>("config", {});
    setHasCli(!!c.cliId);
    void (async () => {
      try {
        const res = await fetch("/api/clis");
        if (!res.ok) return;
        const body = (await res.json()) as { zeroKey?: boolean };
        setZeroKey(body.zeroKey === true);
      } catch {
        /* offline: keep Config wording */
      }
    })();
  }, []);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`/api/posting?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        const found = (d.application as Application | null) ?? null;
        if (found && !forceScore) {
          router.replace(rolePageHref({ n: found.n }));
          return;
        }
        const s = (d.scan as ScanHit | null) ?? null;
        const inbox = (d.inboxJob as InboxJob | null) ?? null;
        setScan(s);
        setInboxJob(inbox);
        setInPipeline(!!d.inPipeline);
        setApp(found);
        setResolvedUrl(inbox?.url || s?.url || url);
        setCompany(found?.company || companyQ || inbox?.company || s?.company || "");
        setRole(found?.role || roleQ || inbox?.role || s?.title || "");
        setLocation(inbox?.location || s?.location || "");
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [url, companyQ, roleQ, forceScore, router]);

  async function trackAs(status: TrackStatus) {
    setTracking(status);
    setTrackErr(null);
    try {
      const res = await fetch("/api/tracker/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, role, url: resolvedUrl || url, status }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; n?: string };
      if (!res.ok) throw new Error(data.error || "could not update tracker");
      if (data.n) router.replace(rolePageHref({ n: data.n }));
      else router.replace(`/pipeline?tab=${status === "SKIP" ? "SKIP" : status.toUpperCase()}`);
    } catch (e) {
      setTrackErr(e instanceof Error ? e.message : "could not update tracker");
    } finally {
      setTracking(null);
    }
  }

  function startScore() {
    // This is when a Workers job is created — evaluation run, not a fake shell.
    enqueueEvaluate([
      {
        title: `Score · ${company || "Role"}`,
        subtitle: role,
        kind: "evaluate",
        input: resolvedUrl || url,
        page: "/pipeline",
      },
    ]);
    router.push("/jobs");
  }

  if (!url) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-brand">
          <ArrowLeft className="size-4" /> Pipeline
        </Link>
        <p className="mt-8 text-sm text-muted">Missing job URL. Open a role from the inbox.</p>
      </div>
    );
  }

  const pdfReady = !!app && /✅|✓|yes|true/i.test(app.pdf || "");
  const postingUrl = resolvedUrl || url;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Pipeline
      </Link>

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {loading && <HeroGlow />}
        <div className="relative z-10">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {loading ? "loading…" : app ? `${app.status} · score later` : "not scored"}
            {inPipeline ? " · in inbox" : scan ? " · from scan" : ""}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <CompanyLogo name={company || "Role"} size={40} />
            <div className="min-w-0">
              <h1 className="font-display text-2xl tracking-tight text-landing">{company || "Role"}</h1>
              {role && <p className="mt-1 text-sm text-muted">{role}</p>}
              {location && <p className="mt-0.5 text-xs text-faint">{location}</p>}
            </div>
          </div>
          {app?.score && (
            <div className="mt-3">
              <Badge tone={scoreTone(app.score)}>{app.score}</Badge>
            </div>
          )}

          {/* Primary action — always visible when unscored / forceScore */}
          {!app && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {hasCli && !zeroKey ? (
                <button
                  type="button"
                  onClick={startScore}
                  className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
                >
                  <Sparkles className="size-4" /> Score this role <CostBadge kind="spend" size="xs" />
                </button>
              ) : (
                <Link
                  href={zeroKey ? "/connect" : "/config"}
                  className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-2 text-sm font-medium text-brand max-sm:min-h-[44px]"
                >
                  <Settings className="size-4" />{" "}
                  {zeroKey ? "Score via Account → MCP" : "Set up an AI CLI to score"}
                </Link>
              )}
            </div>
          )}

          <div className="mt-4">
            <JobInfoPanel
              company={company || "—"}
              role={role}
              appN={app?.n}
              score={app?.score}
              status={app?.status}
              url={postingUrl}
              pdfReady={pdfReady}
              showTrackerActions={!!app}
              showPipelineLink
              footer={
                <div className="space-y-3">
                  {app ? (
                    <>
                      <p className="text-sm text-muted">
                        {zeroKey
                          ? "Already on your tracker. Score in your own assistant — Account → MCP — or change status above."
                          : "Already on your tracker. Score for an A–F fit report (creates a Workers run), or change status above."}
                      </p>
                      {hasCli && !zeroKey && (
                        <button
                          type="button"
                          onClick={startScore}
                          className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
                        >
                          <Sparkles className="size-4" /> Score this role <CostBadge kind="spend" size="xs" />
                        </button>
                      )}
                    </>
                  ) : (
                    <div>
                      <p className="text-xs font-medium text-foreground">Already applied / decide without scoring</p>
                      <p className="mt-0.5 text-[11px] text-faint">
                        Adds a tracker row (score N/A). Free — opens the Job info page with status.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(
                          [
                            ["Applied", "I applied"],
                            ["Discarded", "Discard"],
                            ["SKIP", "Skip forever"],
                          ] as const
                        ).map(([status, label]) => (
                          <button
                            key={status}
                            type="button"
                            disabled={!!tracking}
                            onClick={() => trackAs(status)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
                          >
                            {tracking === status ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Check className="size-3.5" />
                            )}
                            {label}
                          </button>
                        ))}
                      </div>
                      {trackErr && (
                        <p className="mt-2 flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                          <X className="size-3.5" /> {trackErr}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              }
            />
          </div>
        </div>
      </section>

      {/* Scan / inbox facts — durable posting view (not a Workers job until Score) */}
      {(scan || inboxJob) && (
        <section className="mt-6 rounded-2xl border border-border bg-surface/30 px-5 py-4">
          <div className="flex items-center gap-2">
            <Radar className="size-4 text-brand" />
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Scan details</h2>
            <span className="text-[11px] text-faint">· free · 0 tokens</span>
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {(scan?.portal || inboxJob) && (
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-faint">Source</dt>
                <dd className="text-foreground">{scan?.portal || "pipeline inbox"}</dd>
              </div>
            )}
            {(scan?.firstSeen || inboxJob?.postedAt) && (
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-faint">First seen</dt>
                <dd className="tabular-nums text-foreground">{scan?.firstSeen || inboxJob?.postedAt}</dd>
              </div>
            )}
            {location && (
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-faint">Location</dt>
                <dd className="text-foreground">{location}</dd>
              </div>
            )}
            {scan?.status && (
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-faint">Scan status</dt>
                <dd className="text-foreground">{scan.status}</dd>
              </div>
            )}
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-faint">In Pipeline inbox</dt>
              <dd className="text-foreground">{inPipeline ? "Yes" : "No — Add from Fresh matches / Explore"}</dd>
            </div>
            {inboxJob?.compensation && (
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-faint">Compensation</dt>
                <dd className="text-foreground">{inboxJob.compensation}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-[11px] text-faint">
            Workers jobs appear under Workers only after you Score (AI evaluation). This page is the durable posting
            view for unscored roles.
          </p>
        </section>
      )}
    </div>
  );
}

export default function PipelineOpenPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-muted">
          <Loader2 className="inline size-4 animate-spin" /> Loading role…
        </div>
      }
    >
      <OpenRoleInner />
    </Suspense>
  );
}
