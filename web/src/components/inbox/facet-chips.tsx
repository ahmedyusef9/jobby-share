"use client";

import { Search, X, ArrowDownAZ, BookmarkPlus, Trash2 } from "lucide-react";
import type { AtsSource } from "@/lib/explore";
import { ATS_LABEL } from "@/lib/explore";
import {
  FRESHNESS_WINDOWS,
  SENIORITY_LABEL,
  DEFAULT_LOC_PREF,
  POSTED_SORT_LABEL,
  COUNTRY_OPTIONS,
  KW_SUGGESTIONS,
  type Seniority,
  type PostedSort,
} from "@/lib/inbox";
import { CostBadge } from "@/components/cost/cost-badge";
import { cn } from "@/lib/cn";

export type SavedSearch = {
  id: string;
  name: string;
  kw: string;
  locQ: string;
  within: number | null;
  /** Exact posted date YYYY-MM-DD (optional). */
  postedOn?: string | null;
  sources: AtsSource[];
  seniorities: Seniority[];
  postedSort: PostedSort;
};

// Free, client-side facets over the raw firehose — 0 tokens, instant. Mirrors the
// Explore chip language so the two surfaces read as one system. On mobile the chip
// row scrolls INSIDE its own container (never the page).
export function FacetChips({
  within,
  setWithin,
  postedOn,
  setPostedOn,
  sources,
  toggleSource,
  seniorities,
  toggleSeniority,
  locQ,
  setLocQ,
  kw,
  setKw,
  postedSort,
  setPostedSort,
  savedSearches,
  onSaveSearch,
  onApplySaved,
  onDeleteSaved,
  availSources,
  availSeniorities,
  resultCount,
  totalCount,
  anyActive,
  onClear,
}: {
  within: number | null;
  setWithin: (d: number | null) => void;
  postedOn: string | null;
  setPostedOn: (d: string | null) => void;
  sources: Set<AtsSource>;
  toggleSource: (s: AtsSource) => void;
  seniorities: Set<Seniority>;
  toggleSeniority: (s: Seniority) => void;
  locQ: string;
  setLocQ: (v: string) => void;
  kw: string;
  setKw: (v: string) => void;
  postedSort: PostedSort;
  setPostedSort: (s: PostedSort) => void;
  savedSearches: SavedSearch[];
  onSaveSearch: () => void;
  onApplySaved: (s: SavedSearch) => void;
  onDeleteSaved: (id: string) => void;
  availSources: AtsSource[];
  availSeniorities: Seniority[];
  resultCount: number;
  totalCount: number;
  anyActive: boolean;
  onClear: () => void;
}) {
  const countryValue =
    COUNTRY_OPTIONS.some((c) => c.value.toLowerCase() === locQ.trim().toLowerCase())
      ? COUNTRY_OPTIONS.find((c) => c.value.toLowerCase() === locQ.trim().toLowerCase())!.value
      : locQ.trim()
        ? "__custom__"
        : "";

  const toggleKwChip = (term: string) => {
    const tokens = kw.trim().split(/\s+/).filter(Boolean);
    const lower = term.toLowerCase();
    const has = tokens.some((t) => t.toLowerCase() === lower);
    if (has) setKw(tokens.filter((t) => t.toLowerCase() !== lower).join(" "));
    else setKw([...tokens, term].join(" "));
  };

  const kwTokens = new Set(kw.trim().toLowerCase().split(/\s+/).filter(Boolean));

  return (
    <div className="space-y-2.5">
      {/* keyword search + country + save */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="Search company / role — e.g. python software…"
            className="w-full rounded-lg border border-border bg-surface/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40 max-sm:min-h-[44px]"
          />
        </div>

        <select
          value={countryValue === "__custom__" ? "__custom__" : countryValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") return;
            setLocQ(v);
          }}
          className="shrink-0 rounded-lg border border-border bg-surface/60 px-2.5 py-2 text-sm outline-none transition-colors focus:border-brand/50 max-sm:min-h-[44px]"
          title="Country / region filter (sticky)"
          aria-label="Country filter"
        >
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.label} value={c.value}>
              {c.label}
            </option>
          ))}
          {countryValue === "__custom__" && (
            <option value="__custom__">{locQ.trim()}</option>
          )}
        </select>

        <button
          type="button"
          onClick={onSaveSearch}
          disabled={!kw.trim() && !locQ.trim() && within == null && sources.size === 0 && seniorities.size === 0}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-2.5 py-2 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40 max-sm:min-h-[44px]"
          title="Save this search (keywords + country + chips)"
        >
          <BookmarkPlus className="size-3.5" />
          Save
        </button>

        <span className="shrink-0 text-xs text-muted">
          <span className="tabular-nums text-foreground">{resultCount}</span>
          <span className="text-faint">/{totalCount}</span>
        </span>
      </div>

      {/* suggested keywords — toggle into the search bar (AND across tokens) */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Keywords</span>
        {KW_SUGGESTIONS.map((term) => (
          <Pill key={term} on={kwTokens.has(term.toLowerCase())} onClick={() => toggleKwChip(term)}>
            {term}
          </Pill>
        ))}
      </div>

      {/* saved searches */}
      {savedSearches.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Saved</span>
          {savedSearches.map((s) => (
            <span key={s.id} className="inline-flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => onApplySaved(s)}
                className="rounded-full border border-border bg-surface/40 px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
                title={`${s.kw || "(no keywords)"} · ${s.locQ || "any country"}`}
              >
                {s.name}
              </button>
              <button
                type="button"
                onClick={() => onDeleteSaved(s.id)}
                className="rounded-full p-1 text-faint transition-colors hover:text-red-500 max-sm:min-h-[44px] max-sm:min-w-[44px]"
                aria-label={`Delete saved search ${s.name}`}
                title="Delete"
              >
                <Trash2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* chip row — desktop wraps, mobile scrolls inside the container */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
        <div className="inline-flex shrink-0 rounded-lg border border-border bg-surface/40 p-0.5">
          {FRESHNESS_WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => {
                setPostedOn(null);
                setWithin(within === w.days ? null : w.days);
              }}
              className={cn(
                "rounded-md px-2.5 text-xs font-medium transition-colors max-sm:min-h-[44px]",
                within === w.days && !postedOn ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>

        <label
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors max-sm:min-h-[44px]",
            postedOn ? "border-brand/40 bg-brand-soft text-brand" : "border-border bg-surface/40 text-muted",
          )}
          title="Show only jobs posted / first-seen on this date"
        >
          <span className="font-medium">Date</span>
          <input
            type="date"
            value={postedOn || ""}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                setPostedOn(null);
                return;
              }
              setWithin(null);
              setPostedOn(v);
            }}
            className="max-w-[9.5rem] border-0 bg-transparent text-xs text-foreground outline-none"
            aria-label="Filter by exact posted date"
          />
          {postedOn && (
            <button
              type="button"
              onClick={() => setPostedOn(null)}
              className="rounded-full p-0.5 text-faint hover:text-foreground"
              aria-label="Clear date filter"
              title="Clear date"
            >
              <X className="size-3" />
            </button>
          )}
        </label>

        <button
          type="button"
          onClick={() => {
            // Cycle: newest → oldest → most match → newest
            if (postedSort === "desc") setPostedSort("asc");
            else if (postedSort === "asc") setPostedSort("match");
            else setPostedSort("desc");
          }}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors max-sm:min-h-[44px]",
            postedSort === "match"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
              : "border-brand/40 bg-brand-soft text-brand",
          )}
          title={
            postedSort === "match"
              ? "Sorted by keyword fit vs your portals/profile targets (free — not an A–F score)"
              : "Sort by posting / first-seen date — click again for Most match"
          }
        >
          <ArrowDownAZ className="size-3 opacity-70" />
          {POSTED_SORT_LABEL[postedSort]}
        </button>

        {availSources.map((s) => (
          <Pill key={s} on={sources.has(s)} onClick={() => toggleSource(s)}>
            {ATS_LABEL[s]}
          </Pill>
        ))}

        {availSeniorities.map((s) => (
          <Pill key={s} on={seniorities.has(s)} onClick={() => toggleSeniority(s)}>
            {SENIORITY_LABEL[s]}
          </Pill>
        ))}

        {anyActive && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
          >
            <X className="size-3" /> Clear
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <CostBadge kind="free" size="xs" />
        <span className="text-[11px] text-faint">
          Filtering is free. Keyword chips OR together · use +word to require it · country sticks (default{" "}
          {DEFAULT_LOC_PREF}). Pick a <span className="text-muted">Date</span> for one day, or 24h/3d/…. Sort cycles
          Posted ↓ / ↑ / Most match.
        </span>
      </div>
    </div>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-2.5 text-xs font-medium transition-colors max-sm:min-h-[44px]",
        on ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
