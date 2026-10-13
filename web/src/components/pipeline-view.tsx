"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, ChevronsUpDown, X, Compass, ArrowRight, Check } from "lucide-react";
import type { Application, InboxJob } from "@/lib/career-ops";
import type { DiscoveredOffer } from "@/lib/explore";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { CANONICAL_STATES, canonStatus, scoreNum, scoreTone, statusDot } from "@/lib/format";
import { InboxTriage } from "@/components/inbox/inbox-triage";
import { cn } from "@/lib/cn";

// INBOX (the triage queue) is the default tab; the rest filter the tracker.
const TABS = [
  "INBOX",
  "FRESH",
  "ALL",
  "EVALUATED",
  "APPLIED",
  "RESPONDED",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "DISCARDED",
  "SKIP",
] as const;
type Tab = (typeof TABS)[number];

const SORT_KEYS = ["company", "role", "score", "status", "date"] as const;
type SortKey = (typeof SORT_KEYS)[number];

export function PipelineView({
  applications,
  inbox,
  reportUrls,
}: {
  applications: Application[];
  inbox: InboxJob[];
  reportUrls: { url: string; n: string }[];
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // A finished evaluate/pdf worker just wrote a tracker row / report that this
  // server snapshot predates. Debounce refetch — batch Scores used to fire
  // refresh per job and abort live SSE streams (Workers looked stuck spinning).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onDone = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => router.refresh(), 1200);
    };
    window.addEventListener("co-job-done", onDone);
    return () => {
      window.removeEventListener("co-job-done", onDone);
      if (t) clearTimeout(t);
    };
  }, [router]);

  // The URL is the SINGLE source of truth for tab/min/sort/dir, so the home stat
  // tiles' deep links AND the assistant's filterPipeline/navigate actions drive
  // the table identically (no useState mirror → no desync).
  const pTab = (params.get("tab") ?? "").toUpperCase();
  const tab: Tab = (TABS as readonly string[]).includes(pTab) ? (pTab as Tab) : "INBOX";
  const pMin = parseFloat(params.get("min") ?? "");
  const minFilter: number | null = Number.isFinite(pMin) ? pMin : null;
  const pSort = params.get("sort") ?? "";
  const sortKey: SortKey = (SORT_KEYS as readonly string[]).includes(pSort) ? (pSort as SortKey) : "score";
  const sort = { key: sortKey, dir: (params.get("dir") === "1" ? 1 : -1) as 1 | -1 };

  // Search stays LOCAL for snappy typing; seeded from the URL and re-synced only
  // when the URL's q changes (i.e. the assistant set it) — never per keystroke.
  const [q, setQ] = useState(params.get("q") ?? "");
  const lastUrlQ = useRef(params.get("q") ?? "");
  useEffect(() => {
    const urlQ = params.get("q") ?? "";
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ;
      setQ(urlQ);
    }
  }, [params]);

  // Multi-select for bulk status changes on the tracker table (not Inbox).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkStatus, setBulkStatus] = useState<string>("Applied");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [freshOffers, setFreshOffers] = useState<DiscoveredOffer[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/api/whats-new")
      .then((r) => r.json())
      .then((d) => {
        if (alive) setFreshOffers(Array.isArray(d.offers) ? d.offers : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const setParams = useCallback(
    (updates: Record<string, string | number | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") sp.delete(k);
        else sp.set(k, String(v));
      }
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [params, router, pathname],
  );

  // Pending + deduped by URL (pipeline.md can list the same posting twice) so the
  // header count, the tab count and the triage list all agree on one number.
  const pendingInbox = useMemo(() => {
    const seen = new Set<string>();
    const out: InboxJob[] = [];
    for (const j of inbox) {
      if (j.done || seen.has(j.url)) continue;
      seen.add(j.url);
      out.push(j);
    }
    return out;
  }, [inbox]);

  const freshInbox = useMemo(() => {
    const byUrl = new Map(pendingInbox.map((j) => [j.url, j]));
    return freshOffers.map((o) => {
      const hit = byUrl.get(o.url);
      if (hit) return hit;
      return {
        url: o.url,
        company: o.company,
        role: o.title,
        location: o.location,
        done: false,
        postedAt: o.postedAt || undefined,
      } satisfies InboxJob;
    });
  }, [pendingInbox, freshOffers]);

  const filtered = useMemo(() => {
    if (tab === "INBOX" || tab === "FRESH") return [];
    let rows = applications;
    if (tab !== "ALL") rows = rows.filter((r) => canonStatus(r.status).includes(tab));
    if (minFilter != null) {
      rows = rows.filter((r) => {
        const n = scoreNum(r.score);
        return !Number.isNaN(n) && n >= minFilter;
      });
    }
    if (q.trim()) {
      const needle = q.toLowerCase();
      rows = rows.filter((r) => `${r.company} ${r.role}`.toLowerCase().includes(needle));
    }
    return [...rows].sort((a, b) => {
      if (sort.key === "score") {
        const an = scoreNum(a.score);
        const bn = scoreNum(b.score);
        const av = Number.isNaN(an) ? -Infinity : an;
        const bv = Number.isNaN(bn) ? -Infinity : bn;
        return (av - bv) * sort.dir;
      }
      return (a[sort.key] || "").localeCompare(b[sort.key] || "") * sort.dir;
    });
  }, [applications, tab, q, sort, minFilter]);

  const visibleNs = useMemo(() => new Set(filtered.map((r) => r.n)), [filtered]);

  // Drop picks that left the current filter/tab so the bar never acts on hidden rows.
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      let changed = false;
      const next = new Set<string>();
      for (const n of s) {
        if (visibleNs.has(n)) next.add(n);
        else changed = true;
      }
      return changed ? next : s;
    });
  }, [visibleNs]);

  // Clear selection when leaving the tracker table.
  useEffect(() => {
    if (tab === "INBOX") setSelected(new Set());
  }, [tab]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.n));
  const someVisibleSelected = filtered.some((r) => selected.has(r.n));

  const toggleSelect = (n: string) => {
    if (!visibleNs.has(n)) return;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelected((s) => {
        const next = new Set(s);
        for (const r of filtered) next.delete(r.n);
        return next;
      });
      return;
    }
    setSelected(new Set(filtered.map((r) => r.n)));
  };

  const applyBulkStatus = async (statusOverride?: string) => {
    const ns = [...selected];
    const status = statusOverride || bulkStatus;
    if (!ns.length || !status) return;
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ns, status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "write failed");
      const updated = Array.isArray(data.updated) ? data.updated.length : ns.length;
      setBulkMsg(`${updated} → ${data.status || status}`);
      setSelected(new Set());
      setTimeout(() => setBulkMsg(null), 2500);
      router.refresh();
    } catch (e) {
      setBulkMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 max-sm:pb-28">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Pipeline</h1>
          <p className="mt-1 text-sm text-muted">
            <span className="tabular-nums">{pendingInbox.length}</span> in inbox ·{" "}
            <span className="tabular-nums">{applications.length}</span> tracked
          </p>
        </div>
        {/* the tracker has its own search; the inbox brings its own facet filters */}
        {tab !== "INBOX" && tab !== "FRESH" && (
          <div className="relative w-64 max-w-[40vw]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search company or role…"
              className="w-full rounded-md border border-border bg-surface/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </div>
        )}
      </div>

      {/* tabs */}
      <div className="mt-6 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => {
          const count =
            t === "INBOX"
              ? pendingInbox.length
              : t === "FRESH"
                ? freshOffers.length
                : t === "ALL"
                ? applications.length
                : applications.filter((r) => canonStatus(r.status).includes(t)).length;
          return (
            <button
              key={t}
              onClick={() => setParams({ tab: t === "INBOX" ? null : t })}
              className={cn(
                "-mb-px inline-flex items-center justify-center border-b-2 px-3 py-2 text-xs font-medium transition-colors max-sm:min-h-[44px]",
                tab === t
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {t} <span className="text-faint tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      {tab !== "INBOX" && tab !== "FRESH" && minFilter != null && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-faint">Filtered:</span>
          <button
            type="button"
            onClick={() => setParams({ min: null })}
            className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand/15"
            title="Clear score filter"
          >
            score ≥ {minFilter.toFixed(1)}
            <X className="size-3" />
          </button>
        </div>
      )}

      {tab === "FRESH" && (
        <p className="mt-3 text-xs text-faint">
          Unscored scan hits from the last 7 days (same list as Today). Not a CV fit score — click a row, then Score.
        </p>
      )}

      {tab === "INBOX" || tab === "FRESH" ? (
        (tab === "FRESH" ? freshInbox : pendingInbox).length > 0 ? (
          <InboxTriage
            key={tab}
            inbox={tab === "FRESH" ? freshInbox : pendingInbox}
            applications={applications}
            reportUrls={reportUrls}
            isolateFacets={tab === "FRESH"}
          />
        ) : (
          <InboxEmpty count={0} filtered={false} />
        )
      ) : filtered.length > 0 ? (
        /* ── Tracker table ── */
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <button
              type="button"
              onClick={toggleSelectAllVisible}
              className="rounded-full border border-border px-3 py-1.5 font-medium transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
            >
              {allVisibleSelected ? "Deselect all" : `Select all ${filtered.length}`}
            </button>
            <span className="text-faint">
              Check rows → set status in bulk (Applied, Discarded, …)
            </span>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="w-12 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
                    }}
                    onChange={toggleSelectAllVisible}
                    aria-label="Select all visible"
                    className="size-4 accent-brand"
                  />
                </th>
                {SORT_KEYS.map((k) => (
                  <th
                    key={k}
                    className="cursor-pointer select-none px-4 py-2.5 font-medium hover:text-foreground"
                    onClick={() => setParams({ sort: k, dir: sort.key === k ? sort.dir * -1 : -1 })}
                  >
                    <span className="inline-flex items-center gap-1">
                      {k}
                      <ChevronsUpDown className="size-3" />
                    </span>
                  </th>
                ))}
                <th className="px-4 py-2.5 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r, i) => {
                const isOn = selected.has(r.n);
                return (
                  <tr
                    key={`${r.n}-${i}`}
                    className={cn(
                      "group transition-colors hover:bg-surface/40",
                      isOn && "bg-brand-soft/40",
                    )}
                  >
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => toggleSelect(r.n)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${r.company}`}
                        className="size-4 accent-brand"
                      />
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/pipeline/${r.n}`} className="flex items-center gap-2.5 transition-colors group-hover:text-brand">
                        <CompanyLogo name={r.company} size={20} />
                        {r.company}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      <Link href={`/pipeline/${r.n}`}>{r.role}</Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={scoreTone(r.score)}>{r.score || "—"}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(r.status))} />
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-faint tabular-nums">{r.date}</td>
                    <td className="max-w-56 px-4 py-3 text-xs text-muted">
                      {(() => {
                        const notes = typeof r.notes === "string" ? r.notes.trim() : "";
                        const prov = notes.match(/\[scored-by:[^\]]*\]/)?.[0];
                        if (prov) {
                          return (
                            <span title={notes} className="font-mono text-brand">
                              {prov}
                              {notes.replace(prov, "").trim() ? " …" : ""}
                            </span>
                          );
                        }
                        return notes ? (
                          <span title={notes} className="truncate">{notes.slice(0, 60)}</span>
                        ) : (
                          "—"
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
          <p className="font-display text-lg">No matches</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Try a different tab or clear the search.</p>
        </div>
      )}

      {/* Bulk status bar — tracker tabs only */}
      {tab !== "INBOX" && tab !== "FRESH" && selected.size > 0 && (
        <div
          role="region"
          aria-label="Bulk status"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-brand/30 bg-surface/95 p-3 shadow-lg backdrop-blur sm:inset-x-auto sm:bottom-6 sm:left-1/2 sm:w-full sm:max-w-2xl sm:-translate-x-1/2 sm:rounded-2xl sm:border"
        >
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-landing">
              <span className="tabular-nums">{selected.size}</span> selected
              {bulkMsg && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-brand">
                  <Check className="size-3" /> {bulkMsg}
                </span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {(["Applied", "Evaluated", "Discarded", "SKIP"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => {
                    setBulkStatus(s);
                    void applyBulkStatus(s);
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 max-sm:min-h-[44px]",
                    s === "Applied"
                      ? "border-brand/40 bg-brand text-brand-foreground hover:bg-brand-200"
                      : "border-border text-muted hover:border-brand/40 hover:text-brand",
                  )}
                >
                  {s}
                </button>
              ))}
              <label className="sr-only" htmlFor="bulk-status">
                New status
              </label>
              <select
                id="bulk-status"
                value={bulkStatus}
                onChange={(e) => setBulkStatus(e.target.value)}
                disabled={bulkBusy}
                className="rounded-md border border-border bg-surface px-2.5 py-2 text-sm outline-none focus:border-brand/50 disabled:opacity-50 max-sm:min-h-[44px]"
              >
                {CANONICAL_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void applyBulkStatus()}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
              >
                {bulkBusy ? "Saving…" : "Set"}
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => setSelected(new Set())}
                className="rounded-full px-3 py-2 text-xs text-muted hover:text-foreground max-sm:min-h-[44px]"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Empty inbox. Self-sufficient for the mainstream user (a primary in-web action),
// honest for devs (the CLI/file path stays, demoted to progressive transparency).
function InboxEmpty({ count, filtered }: { count: number; filtered: boolean }) {
  if (filtered) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
        <p className="font-display text-lg">No matches</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Clear the search to see the full inbox.</p>
      </div>
    );
  }
  return (
    <div className="dot-bg mt-4 overflow-hidden rounded-2xl border border-border bg-surface/50 bg-origin-border bg-gradient-to-tr from-brand/10 via-transparent to-transparent shadow-lg">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-5 py-3">
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="ml-3 font-mono text-xs tracking-wide text-muted">jobby · inbox</span>
      </div>
      <div className="px-6 py-10 text-center">
        <p className="font-display text-lg">
          Your <span className="text-brand">inbox</span> is empty.
        </p>
        {count > 0 ? (
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">Nothing pending right now.</p>
        ) : (
          <>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">Find roles that match your CV — free, no tokens spent.</p>
            <Link
              href="/explore?run=1"
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground shadow-sm transition-all duration-200 hover:bg-brand-200 hover:-translate-y-0.5 hover:shadow-md"
            >
              <Compass className="size-4" /> Run your first free scan <ArrowRight className="size-4" />
            </Link>
            <p className="mx-auto mt-4 max-w-sm text-xs text-muted">
              Prefer the terminal? Run <code className="rounded bg-surface-hover px-1 py-0.5 font-mono">career-ops scan</code>, or add job URLs to{" "}
              <code className="rounded bg-surface-hover px-1 py-0.5 font-mono">data/pipeline.md</code>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
