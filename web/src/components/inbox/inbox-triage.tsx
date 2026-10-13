"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Undo2, Sparkles, Pause, Play, X as XIcon, Loader2, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { useJobs, type Job, queuedCaption } from "@/components/jobs/job-store";
import type { Application, InboxJob } from "@/lib/career-ops";
import type { AtsSource } from "@/lib/explore";
import { ATS_SOURCES } from "@/lib/explore";
import { daysSince, seniorityFromTitle, sourceFromUrl, SENIORITY_ORDER, DEFAULT_LOC_PREF, locationMatchesQuery, keywordMatchesQuery, keywordFitScore, type Seniority, type PostedSort } from "@/lib/inbox";
import { scoreNum, scoreTone, normUrl } from "@/lib/format";
import { FacetChips, type SavedSearch } from "./facet-chips";
import { TriageRow, type RowScore } from "./triage-row";
import { ShortlistTray, type ShortItem } from "./shortlist-tray";
import { CostBadge } from "@/components/cost/cost-badge";
import { humanizeStep } from "@/components/jobs/worker-card";
import { rolePageHref } from "@/lib/role-href";
import { cn } from "@/lib/cn";
import { lsReadJson, lsRead, lsWriteJson, lsWrite } from "@/lib/storage";

const BATCH = 20;
/** Rough wall-clock when we have no finished samples yet (~2 min per Score on this account). */
const FALLBACK_MS_PER_EVAL = 120_000;
/** Ollama/qwen on one M1 runner is much slower — honest ETA for free-model batches. */
const FALLBACK_MS_PER_EVAL_OLLAMA = 360_000;

function formatEta(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `~${h}h ${rem}m` : `~${h}h`;
}

// An evaluate run queued behind the concurrency cap. Structurally matches the job
// store's StartOpts (not exported) — the fields enqueueEvaluate forwards to startJob.
type EvalItem = { title: string; subtitle?: string; kind: "evaluate"; input: string; page: string };

// The inbox as a TRIAGE + APPLY surface: master (triage list) on the left, detail
// (report + Apply) on the right. Auto-eval is opt-in but batchable — "Score all
// pending" keeps extra rows in your list. Redis holds at most one running Score
// and one waiting Score for this account. Scores come from a live worker OR the
// persisted tracker (so they survive a reload). Order is freshness; a single
// documented plug point keeps relevance out of the shell.
export function InboxTriage({
  inbox,
  applications = [],
  reportUrls = [],
  isolateFacets = false,
}: {
  inbox: InboxJob[];
  applications?: Application[];
  reportUrls?: { url: string; n: string }[];
  /** Fresh-this-week tab: do not load/save INBOX keyword chips (they hide Hebrew titles). */
  isolateFacets?: boolean;
}) {
  const { jobs, enqueueEvaluate, pauseQueue, resumeQueue, clearQueue, queueStats, pendingQueue } = useJobs();
  const [showQueueDetail, setShowQueueDetail] = useState(true);
  const router = useRouter();
  const params = useSearchParams();

  // facets — location defaults to Israel and sticks across visits
  const [within, setWithin] = useState<number | null>(null);
  const [postedOn, setPostedOn] = useState<string | null>(null);
  const [sources, setSources] = useState<Set<AtsSource>>(() => new Set());
  const [seniorities, setSeniorities] = useState<Set<Seniority>>(() => new Set());
  const [locQ, setLocQ] = useState(DEFAULT_LOC_PREF);
  const [kw, setKw] = useState("");
  const [postedSort, setPostedSort] = useState<PostedSort>("desc");
  const [showAll, setShowAll] = useState(false);
  const [locPref, setLocPref] = useState(DEFAULT_LOC_PREF);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [matchPositive, setMatchPositive] = useState<string[]>([]);
  const [matchNegative, setMatchNegative] = useState<string[]>([]);

  // M2 search-profile facet: filter the inbox by which isolated scan produced each
  // row. profileTitle maps id→title (deleted profiles fall back to the bare id so a
  // row never orphans). profileFilter is a multi-select OR over the selected ids.
  const [profileTitle, setProfileTitle] = useState<Map<string, string>>(() => new Map());
  const [profileFilter, setProfileFilter] = useState<Set<string>>(() => new Set());

  // persisted triage state + ephemeral selection/undo
  const [shortlist, setShortlist] = useState<ShortItem[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<{ label: string; fn: () => void } | null>(null);
  const [hasCli, setHasCli] = useState(false);
  // Zero-key members (BL-058): refusal copy points at MCP, never at Config.
  const [zeroKey, setZeroKey] = useState(false);
  const [cliId, setCliId] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    const s = lsReadJson<ShortItem[]>("shortlist", []);
    if (s.length) setShortlist(s);
    const h = lsReadJson<string[]>("hidden", []);
    if (h.length) setHidden(h);
    const c = lsReadJson<{ cliId?: string }>("config", {});
    setHasCli(!!c.cliId);
    void (async () => {
      try {
        const res = await fetch("/api/clis");
        if (!res.ok) return;
        const body = (await res.json()) as { zeroKey?: boolean };
        setZeroKey(body.zeroKey === true);
      } catch {
        /* offline: keep Config wording, harmless */
      }
    })();
    setCliId(String(c.cliId || ""));
    const pref = lsRead<string>("inbox-loc-pref") ?? "";
    if (pref !== "") setLocPref(pref);
    else setLocPref(DEFAULT_LOC_PREF);

    if (!isolateFacets) {
      const f = lsReadJson<{
        within?: number | null;
        postedOn?: string | null;
        sources?: AtsSource[];
        seniorities?: Seniority[];
        locQ?: string;
        kw?: string;
        postedSort?: PostedSort;
      }>("inbox-facets", {});
      if (typeof f.within === "number" || f.within === null) setWithin(f.within ?? null);
      if (typeof f.postedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.postedOn)) setPostedOn(f.postedOn);
      else if (f.postedOn === null) setPostedOn(null);
      if (Array.isArray(f.sources)) setSources(new Set(f.sources));
      if (Array.isArray(f.seniorities)) setSeniorities(new Set(f.seniorities));
      if (typeof f.locQ === "string") setLocQ(f.locQ);
      else setLocQ(pref && pref !== "" ? pref : DEFAULT_LOC_PREF);
      if (typeof f.kw === "string") setKw(f.kw);
      if (f.postedSort === "asc" || f.postedSort === "desc" || f.postedSort === "match") setPostedSort(f.postedSort);
    } else {
      setLocQ("");
      setKw("");
      setWithin(null);
      setPostedOn(null);
      setSources(new Set());
      setSeniorities(new Set());
      setPostedSort("desc");
    }

    const arr = lsReadJson<unknown[]>("inbox-saved-searches", []);
    if (Array.isArray(arr)) setSavedSearches(arr as SavedSearch[]);
    setLoaded(true);
  }, [isolateFacets]);

  // Target keywords for free "Most match" sort (portals.yml / profile.yml).
  useEffect(() => {
    let alive = true;
    fetch("/api/match-hints")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        if (Array.isArray(d.positive)) setMatchPositive(d.positive.map(String));
        if (Array.isArray(d.negative)) setMatchNegative(d.negative.map(String));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // M2: load search-profile titles so the Profile facet can label chips by name.
  // Deleted profiles fall back to the bare id (rendered as a neutral chip) so a row
  // never orphans when its profile is removed.
  useEffect(() => {
    let alive = true;
    fetch("/api/search-profiles", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d || !Array.isArray(d.profiles)) return;
        const m = new Map<string, string>();
        for (const p of d.profiles) m.set(String(p.id), String(p.title));
        setProfileTitle(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (loaded) lsWriteJson("shortlist", shortlist);
  }, [shortlist, loaded]);
  useEffect(() => {
    if (loaded) lsWriteJson("hidden", hidden);
  }, [hidden, loaded]);
  useEffect(() => {
    if (!loaded) return;
    lsWriteJson("inbox-saved-searches", savedSearches.slice(0, 20));
  }, [savedSearches, loaded]);
  useEffect(() => {
    if (!loaded || isolateFacets) return;
    lsWriteJson("inbox-facets", {
      within,
      postedOn,
      sources: [...sources],
      seniorities: [...seniorities],
      locQ,
      kw,
      postedSort,
    });
    // Remember last non-empty location as the sticky preference (Clear restores it).
    if (locQ.trim()) {
      lsWrite("inbox-loc-pref", locQ.trim());
      setLocPref(locQ.trim());
    }
  }, [within, postedOn, sources, seniorities, locQ, kw, postedSort, loaded, isolateFacets]);
  // auto-dismiss the undo toast
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 5000);
    return () => clearTimeout(t);
  }, [undo]);

  // stable "now" for freshness (per mount)
  const now = useMemo(() => Date.now(), []);

  // Dedupe by URL — pipeline.md can list the same posting twice; it's one job, so it
  // triages once (and Save/Skip/score, all keyed by URL, act on it coherently).
  const enriched = useMemo(() => {
    const seen = new Set<string>();
    const out: {
      job: InboxJob;
      source: AtsSource | null;
      seniority: Seniority | null;
      age: number | null;
      fit: number;
      fitHits: string[];
    }[] = [];
    for (const job of inbox) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      const { score, hits } = keywordFitScore(job.company, job.role, matchPositive, matchNegative);
      out.push({
        job,
        source: sourceFromUrl(job.url),
        seniority: seniorityFromTitle(job.role),
        age: daysSince(job.postedAt, now),
        fit: score,
        fitHits: hits,
      });
    }
    return out;
  }, [inbox, now, matchPositive, matchNegative]);

  // posting URL -> its tracker Application, joined through the report's URL header
  // (reportUrls = url→report#, applications keyed by #). This is what lets a scored
  // role show its badge after the live worker has aged out of memory.
  const appByUrl = useMemo(() => {
    const byNum = new Map<string, Application>();
    for (const a of applications) byNum.set(String(parseInt(a.n, 10)), a);
    const m = new Map<string, Application>();
    for (const { url, n } of reportUrls) {
      const app = byNum.get(String(parseInt(n, 10)));
      if (app) m.set(normUrl(url), app);
    }
    return m;
  }, [applications, reportUrls]);

  // Legacy ?job= deep links → dedicated role page (same Job info as Workers)
  useEffect(() => {
    const jobUrl = params.get("job");
    if (!jobUrl) return;
    const hit = inbox.find((j) => normUrl(j.url) === normUrl(jobUrl));
    const n = appByUrl.get(normUrl(jobUrl))?.n;
    router.replace(
      rolePageHref({
        n: n ?? null,
        url: jobUrl,
        company: hit?.company,
        role: hit?.role,
      }),
    );
  }, [params, inbox, appByUrl, router]);

  // latest live evaluate worker per posting URL (running → badge/spinner)
  const liveByUrl = useMemo(() => {
    const best = new Map<string, Job>();
    for (const j of jobs) {
      if (!j.input || j.kind !== "evaluate") continue;
      const k = normUrl(j.input);
      const ex = best.get(k);
      if (!ex || j.startedAt > ex.startedAt) best.set(k, j);
    }
    return best;
  }, [jobs]);

  const openRole = useCallback(
    (job: InboxJob) => {
      const live = liveByUrl.get(normUrl(job.url));
      if (live && (live.status === "running" || live.status === "queued" || live.status === "error")) {
        router.push(`/jobs/${live.id}`);
        return;
      }
      const n = appByUrl.get(normUrl(job.url))?.n;
      router.push(rolePageHref({ n: n ?? null, url: job.url, company: job.company, role: job.role }));
    },
    [appByUrl, liveByUrl, router],
  );

  const pendingUrlSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of pendingQueue) if (p.input) s.add(normUrl(p.input));
    return s;
  }, [pendingQueue]);

  // Merge: tracker score first (persisted), a live worker overrides it (fresher /
  // shows the running spinner / Failed). Pending queue marks Queued. Keyed by URL.
  const scoreByUrl = useMemo(() => {
    const m = new Map<string, RowScore>();
    for (const [nurl, app] of appByUrl) {
      const sn = scoreNum(app.score);
      m.set(nurl, { score: Number.isNaN(sn) ? null : sn, tone: scoreTone(app.score), running: false, n: app.n });
    }
    for (const [k, j] of liveByUrl) {
      const prev = m.get(k);
      m.set(k, {
        score: j.result?.score ?? prev?.score ?? null,
        tone: j.result?.tone ?? prev?.tone ?? "muted",
        running: j.status === "running",
        queued: j.status === "queued",
        queuePosition: j.queuePosition,
        error: j.status === "error",
        jobId: j.id,
        n: prev?.n,
      });
    }
    for (const url of pendingUrlSet) {
      const prev = m.get(url);
      if (prev?.running || prev?.queued || prev?.score != null) continue;
      m.set(url, {
        score: prev?.score ?? null,
        tone: prev?.tone ?? "muted",
        running: false,
        queued: true,
        n: prev?.n,
      });
    }
    return m;
  }, [appByUrl, liveByUrl, pendingUrlSet]);

  // facet options — only surface what's actually present in the (non-hidden) data
  const availSources = useMemo(() => {
    const set = new Set<AtsSource>();
    for (const e of enriched) if (e.source && !hidden.includes(e.job.url)) set.add(e.source);
    return ATS_SOURCES.filter((s) => set.has(s));
  }, [enriched, hidden]);
  const availSeniorities = useMemo(() => {
    const set = new Set<Seniority>();
    for (const e of enriched) if (e.seniority && !hidden.includes(e.job.url)) set.add(e.seniority);
    return SENIORITY_ORDER.filter((s) => set.has(s));
  }, [enriched, hidden]);
  // M2: which profile ids are present in the (non-hidden) inbox — drives the chip row.
  const availProfileIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of enriched) {
      if (e.job.profileId && !hidden.includes(e.job.url)) set.add(e.job.profileId);
    }
    return [...set].sort((a, b) => (profileTitle.get(a) || a).localeCompare(profileTitle.get(b) || b));
  }, [enriched, hidden, profileTitle]);

  const filtered = useMemo(
    () =>
      enriched.filter((e) => {
        if (hidden.includes(e.job.url)) return false;
        if (postedOn) {
          if (e.job.postedAt !== postedOn) return false;
        } else if (within != null && (e.age == null || e.age > within)) {
          return false;
        }
        if (sources.size && (!e.source || !sources.has(e.source))) return false;
        if (seniorities.size && (!e.seniority || !seniorities.has(e.seniority))) return false;
        if (profileFilter.size && (!e.job.profileId || !profileFilter.has(e.job.profileId))) return false;
        if (locQ.trim() && !locationMatchesQuery(e.job.location, locQ)) return false;
        if (kw.trim() && !keywordMatchesQuery(e.job.company, e.job.role, kw)) return false;
        return true;
      }),
    [enriched, hidden, within, postedOn, sources, seniorities, profileFilter, locQ, kw],
  );

  // Order: published date (default) OR keyword fit when Most match is on.
  // While a score queue is active, boost running → queued → rest so progress is visible.
  const ordered = useMemo(() => {
    const queueLive =
      pendingUrlSet.size > 0 ||
      jobs.some((j) => j.kind === "evaluate" && (j.status === "running" || j.status === "queued"));
    const byPublished = (a: (typeof filtered)[number], b: (typeof filtered)[number]) => {
      const ad = a.job.postedAt || "";
      const bd = b.job.postedAt || "";
      let cmp = 0;
      if (ad && bd) cmp = ad.localeCompare(bd); // YYYY-MM-DD
      else if (ad && !bd) cmp = -1;
      else if (!ad && bd) cmp = 1;
      else cmp = (a.age ?? Infinity) - (b.age ?? Infinity);
      return postedSort === "asc" ? cmp : -cmp;
    };
    const byFit = (a: (typeof filtered)[number], b: (typeof filtered)[number]) => {
      if (b.fit !== a.fit) return b.fit - a.fit;
      return byPublished(a, b);
    };
    return [...filtered].sort((a, b) => {
      if (queueLive) {
        const band = (url: string) => {
          const s = scoreByUrl.get(normUrl(url));
          if (s?.running) return 0;
          if (s?.queued) return 1;
          if (s?.error && s.score == null) return 2;
          return 3;
        };
        const d = band(a.job.url) - band(b.job.url);
        if (d !== 0) return d;
      }
      return postedSort === "match" ? byFit(a, b) : byPublished(a, b);
    });
  }, [filtered, pendingUrlSet, jobs, scoreByUrl, postedSort]);

  const anyFacet =
    within != null ||
    !!postedOn ||
    sources.size > 0 ||
    seniorities.size > 0 ||
    profileFilter.size > 0 ||
    locQ.trim() !== "" ||
    kw.trim() !== "";
  const capped = !showAll && !anyFacet;
  const visible = capped ? ordered.slice(0, BATCH) : ordered;
  const hiddenCount = hidden.length;

  const isShortlisted = (url: string) => shortlist.some((s) => s.url === url);

  const save = (job: InboxJob) => {
    if (isShortlisted(job.url)) return;
    setShortlist((s) => [...s, { url: job.url, company: job.company, role: job.role }]);
  };
  const skip = (job: InboxJob) => {
    setHidden((h) => (h.includes(job.url) ? h : [...h, job.url]));
    setUndo({ label: `Skipped ${job.company}`, fn: () => setHidden((h) => h.filter((u) => u !== job.url)) });
  };
  const needsScore = useCallback(
    (url: string) => {
      const s = scoreByUrl.get(normUrl(url));
      if (!s) return true;
      if (s.running || s.queued) return false;
      if (s.score != null) return false; // already evaluated — never re-queue
      return true; // not scored, or Failed (error + no score)
    },
    [scoreByUrl],
  );

  const selectableVisible = useMemo(
    () => visible.filter((e) => needsScore(e.job.url)),
    [visible, needsScore],
  );

  // URLs in the current facet/fresh view — Select all must never spill outside this set.
  const visibleUrlSet = useMemo(() => new Set(visible.map((e) => e.job.url)), [visible]);

  // Drop picks that left the current filter view (keep scored picks — shortlist / select-all).
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      let changed = false;
      const n = new Set<string>();
      for (const url of s) {
        if (visibleUrlSet.has(url)) n.add(url);
        else changed = true;
      }
      return changed ? n : s;
    });
  }, [visibleUrlSet]);

  const toggleSelect = (url: string) => {
    if (!visibleUrlSet.has(url)) return; // can't select what isn't in the current filter view
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });
  };

  /** All visible rows in the current filter (e.g. all 26 on a chosen date). */
  const allVisibleSelected =
    visible.length > 0 && visible.every((e) => selected.has(e.job.url));
  const allUnscoredSelected =
    selectableVisible.length > 0 && selectableVisible.every((e) => selected.has(e.job.url));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelected((s) => {
        const n = new Set(s);
        for (const e of visible) n.delete(e.job.url);
        return n;
      });
      return;
    }
    // Select every row in the current filter / fresh slice (scored + unscored).
    setSelected(new Set(visible.map((e) => e.job.url)));
  };

  const selectUnscoredOnly = () => {
    if (allUnscoredSelected && selected.size === selectableVisible.length) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(selectableVisible.map((e) => e.job.url)));
  };
  const saveSelected = () => {
    const add = enriched
      .filter((e) => selected.has(e.job.url) && !isShortlisted(e.job.url))
      .map((e) => ({ url: e.job.url, company: e.job.company, role: e.job.role }));
    if (add.length) setShortlist((s) => [...s, ...add]);
    setSelected(new Set());
  };
  // Score only the checkbox selection that is still unscored / not in flight,
  // and still in the current filter view (never score a stale out-of-filter pick).
  const scoreSelected = () => {
    const items: EvalItem[] = [];
    for (const e of visible) {
      if (!selected.has(e.job.url)) continue;
      const s = scoreByUrl.get(normUrl(e.job.url));
      if (s && (s.running || s.queued || s.score != null)) continue;
      items.push({ title: `Score · ${e.job.company}`, subtitle: e.job.role, kind: "evaluate", input: e.job.url, page: "/pipeline" });
    }
    if (items.length) {
      enqueueEvaluate(items);
      setSelected(new Set());
    }
  };
  const selectedUnscoredCount = useMemo(() => {
    let n = 0;
    for (const url of selected) {
      const s = scoreByUrl.get(normUrl(url));
      if (!s || (!s.running && !s.queued && s.score == null)) n += 1;
    }
    return n;
  }, [selected, scoreByUrl]);

  // avg per-eval cost from finished workers, scaled to a count (shortlist or "all")
  const avgCost = useMemo(() => {
    const samples = jobs.filter((j) => j.kind === "evaluate" && j.status === "done" && j.cost?.tokens).map((j) => j.cost!);
    if (!samples.length) return null;
    const avgT = samples.reduce((a, c) => a + c.tokens, 0) / samples.length;
    const usds = samples.filter((s) => s.usd != null).map((s) => s.usd!);
    const avgUsd = usds.length ? usds.reduce((a, c) => a + c, 0) / usds.length : undefined;
    return { tokens: avgT, usd: avgUsd };
  }, [jobs]);

  // Wall-clock ETA from finished evaluate durations.
  // Ollama is free but serial (1 runner on the lab M1) — don't pretend it's 3-wide.
  const isOllama = cliId === "ollama";
  const avgEvalMs = useMemo(() => {
    const samples = jobs.filter(
      (j) => j.kind === "evaluate" && j.status === "done" && j.endedAt && j.startedAt,
    );
    const fallback = isOllama ? FALLBACK_MS_PER_EVAL_OLLAMA : FALLBACK_MS_PER_EVAL;
    if (samples.length < 2) return fallback;
    const sum = samples.reduce((a, j) => a + (j.endedAt! - j.startedAt), 0);
    return Math.max(30_000, sum / samples.length);
  }, [jobs, isOllama]);
  // This account is capped at one running Score (D-023). Do not divide by the
  // old browser pump of 3, or by host concurrency the tenant cannot use.
  const etaFor = (remaining: number) =>
    remaining > 0 ? formatEta(remaining * avgEvalMs) : null;

  const estimateFor = (count: number) =>
    avgCost && count > 0
      ? { tokens: Math.round(avgCost.tokens * count), usd: avgCost.usd != null ? +(avgCost.usd * count).toFixed(2) : undefined }
      : {};

  const shortlistEstimate = useMemo(() => estimateFor(shortlist.length), [avgCost, shortlist.length]);

  const scoreShortlist = () => {
    // Route through the same Score list so shortlist scoring cannot jump the fairness cap.
    enqueueEvaluate(
      shortlist.map<EvalItem>((it) => ({ title: `Score · ${it.company}`, subtitle: it.role, kind: "evaluate", input: it.url, page: "/pipeline" })),
    );
    setShortlist([]);
  };

  // Unscored roles in the *current facet view* (or full inbox when no facets).
  // Filter-then-evaluate must not silently expand past what the user is looking at.
  // Failed rows are excluded here — use Retry failed so a 401-batch doesn't re-hide them.
  const scoreAllCandidates = useMemo<EvalItem[]>(() => {
    const pool = anyFacet ? filtered : enriched.filter((e) => !hidden.includes(e.job.url));
    const out: EvalItem[] = [];
    for (const e of pool) {
      const s = scoreByUrl.get(normUrl(e.job.url));
      if (s?.error && s.score == null) continue;
      if (s && (s.running || s.queued || s.score != null)) continue;
      out.push({ title: `Score · ${e.job.company}`, subtitle: e.job.role, kind: "evaluate", input: e.job.url, page: "/pipeline" });
    }
    return out;
  }, [anyFacet, filtered, enriched, hidden, scoreByUrl]);

  // Failed evaluates in the current filter (or whole inbox) — retry without the 401.
  const failedCandidates = useMemo<EvalItem[]>(() => {
    const pool = anyFacet ? filtered : enriched.filter((e) => !hidden.includes(e.job.url));
    const out: EvalItem[] = [];
    for (const e of pool) {
      const s = scoreByUrl.get(normUrl(e.job.url));
      if (!s?.error || s.score != null || s.running || s.queued) continue;
      out.push({ title: `Score · ${e.job.company}`, subtitle: e.job.role, kind: "evaluate", input: e.job.url, page: "/pipeline" });
    }
    return out;
  }, [anyFacet, filtered, enriched, hidden, scoreByUrl]);

  const retryFailed = () => {
    if (!failedCandidates.length) return;
    enqueueEvaluate(failedCandidates);
    setShowQueueDetail(true);
  };

  const queueActive = queueStats.pending > 0 || queueStats.running > 0 || queueStats.queued > 0;
  const allEstimate = estimateFor(scoreAllCandidates.length);

  const runningJobs = useMemo(
    () => jobs.filter((j) => j.kind === "evaluate" && j.status === "running"),
    [jobs],
  );
  const queuedJobs = useMemo(
    () => jobs.filter((j) => j.kind === "evaluate" && j.status === "queued"),
    [jobs],
  );
  const recentEvalJobs = useMemo(
    () =>
      jobs
        .filter((j) => j.kind === "evaluate" && (j.status === "done" || j.status === "error"))
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
        .slice(0, 8),
    [jobs],
  );
  const sessionDone = useMemo(
    () => jobs.filter((j) => j.kind === "evaluate" && j.status === "done").length,
    [jobs],
  );
  const sessionFailed = useMemo(
    () => jobs.filter((j) => j.kind === "evaluate" && j.status === "error").length,
    [jobs],
  );
  const remainingWork = queueStats.pending + queueStats.running + queueStats.queued;
  const queueEta = etaFor(remainingWork);

  // selected row → detail pane inputs
  // The parent (PipelineView) renders the rich empty-inbox card; here we always
  // have ≥1 raw posting.
  if (inbox.length === 0) return null;

  return (
    <div className={cn("mt-4", shortlist.length > 0 && "pb-28 sm:pb-24")}>
      {/* ── batch queue bar: Score all pending + live progress ── */}
      <div className="mb-4 rounded-xl border border-border bg-surface/50">
        <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          {queueActive ? (
            <>
              <button
                type="button"
                onClick={() => setShowQueueDetail((v) => !v)}
                className="inline-flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-brand max-sm:min-h-[44px]"
              >
                {queueStats.running > 0 ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : (
                  <Loader2 className="size-4 shrink-0 text-muted" />
                )}
                <span className="min-w-0 truncate">
                  {queueStats.running > 0
                    ? `Evaluating ${queueStats.running}`
                    : queueStats.queued > 0
                      ? `Queued ${queueStats.queued}`
                      : "Score list"}
                  {queueStats.running > 0 && queueStats.queued > 0 && ` · ${queueStats.queued} queued`}
                  {queueStats.pending > 0 && ` · ${queueStats.pending} in your list`}
                  {sessionDone > 0 && <span className="font-normal text-muted"> · {sessionDone} done</span>}
                  {sessionFailed > 0 && <span className="font-normal text-red-500"> · {sessionFailed} failed</span>}
                  {queueEta && <span className="font-normal text-muted"> · ETA {queueEta}</span>}
                </span>
                {showQueueDetail ? <ChevronUp className="ml-auto size-4 shrink-0 text-muted" /> : <ChevronDown className="ml-auto size-4 shrink-0 text-muted" />}
              </button>
              <div className="flex items-center gap-2">
                {queueStats.paused ? (
                  <button type="button" onClick={resumeQueue} className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1.5 text-xs font-medium text-brand max-sm:min-h-[44px]">
                    <Play className="size-3.5" /> Resume
                  </button>
                ) : (
                  <button type="button" onClick={pauseQueue} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]">
                    <Pause className="size-3.5" /> Pause
                  </button>
                )}
                <button type="button" onClick={clearQueue} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]" title="Cancel the queued runs (in-flight ones finish)">
                  <XIcon className="size-3.5" /> Cancel queue
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Auto-evaluate your inbox</p>
                <p className="text-xs text-muted">
                  {scoreAllCandidates.length > 0
                    ? anyFacet
                      ? `${scoreAllCandidates.length} unscored in current filters · 1 Score at a time on this account${isOllama ? " (Ollama free)" : ""} · ETA ${etaFor(scoreAllCandidates.length) ?? "—"}`
                      : `${scoreAllCandidates.length} unscored · 1 Score at a time on this account${isOllama ? " · free Ollama (serial)" : ""} · ETA ${etaFor(scoreAllCandidates.length) ?? "—"} for a full batch`
                    : anyFacet
                      ? "Every role in this filter is scored."
                      : "Every visible role is scored."}
                </p>
              </div>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                {!hasCli && (
                  <a
                    href={zeroKey ? "/connect" : "/config"}
                    className="text-xs font-medium text-brand hover:underline"
                  >
                    {zeroKey ? "Score via your own assistant — Account → MCP →" : "Pick Claude or Ollama in Config →"}
                  </a>
                )}
                {failedCandidates.length > 0 && (
                  <button
                    type="button"
                    disabled={!hasCli || queueActive}
                    onClick={retryFailed}
                    className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 max-sm:min-h-[44px]"
                    title="Re-queue only roles that failed scoring"
                  >
                    <RotateCcw className="size-3.5" />
                    Retry failed {failedCandidates.length}
                  </button>
                )}
                {!confirmAll ? (
                  <button
                    type="button"
                    disabled={!hasCli || scoreAllCandidates.length === 0}
                    onClick={() => setConfirmAll(true)}
                    className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
                    title={!hasCli ? (zeroKey ? "Scoring runs in your own assistant — connect under Account → MCP" : "Pick Claude or Ollama in Config first") : isOllama ? "Free via Ollama — runs one at a time on your lab Mac" : "Score every unscored role in your inbox"}
                  >
                    <Sparkles className="size-4" />{" "}
                    {anyFacet ? `Score filtered ${scoreAllCandidates.length || ""}` : `Score all ${scoreAllCandidates.length || ""}`}
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="hidden items-center gap-1 text-[11px] text-muted sm:inline-flex">
                      {isOllama ? (
                        <>
                          Free via Ollama · ~{etaFor(scoreAllCandidates.length) ?? "—"} serial
                          {scoreAllCandidates.length >= 10 && (
                            <span className="text-amber-700 dark:text-amber-300">
                              · large queue OK overnight — or filter + Score selected
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <CostBadge kind="spend" size="xs" />
                          {allEstimate.tokens
                            ? `≈ ${Math.round(allEstimate.tokens / 1000)}k tokens${allEstimate.usd != null ? ` · ≈ $${allEstimate.usd.toFixed(2)}` : ""}`
                            : "uses your tokens"}
                          {scoreAllCandidates.length >= 20 && (
                            <span className="text-amber-700 dark:text-amber-300">
                              · large batch ({etaFor(scoreAllCandidates.length)}) — prefer a tighter filter or Score selected
                            </span>
                          )}
                        </>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        enqueueEvaluate(scoreAllCandidates);
                        setConfirmAll(false);
                        setShowQueueDetail(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
                    >
                      Score {scoreAllCandidates.length} {anyFacet ? "filtered" : "now"}
                    </button>
                    <button type="button" onClick={() => setConfirmAll(false)} className="rounded-full px-2 py-2 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]">
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {queueActive && showQueueDetail && (
          <div className="border-t border-border px-3 py-3 text-xs">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Running now</p>
                {runningJobs.length === 0 ? (
                  <p className="text-muted">{queueStats.paused ? "Paused" : "Waiting for a free slot…"}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {runningJobs.map((j) => {
                      const step = j.steps[j.steps.length - 1]?.label;
                      return (
                        <li key={j.id} className="min-w-0">
                          <Link href={`/jobs/${j.id}`} className="block truncate font-medium text-foreground hover:text-brand">
                            {j.title.replace(/^Score · /, "")}
                            {j.subtitle ? ` · ${j.subtitle}` : ""}
                          </Link>
                          <p className="truncate text-faint">{step ? humanizeStep(step) : "Evaluating…"}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Up next</p>
                {queuedJobs.length === 0 && pendingQueue.length === 0 ? (
                  <p className="text-muted">Queue empty</p>
                ) : (
                  <ul className="space-y-1">
                    {queuedJobs.map((j) => (
                      <li key={j.id} className="truncate text-muted">
                        <Link href={`/jobs/${j.id}`} className="font-medium text-foreground hover:text-brand">
                          {j.title.replace(/^Score · /, "")}
                        </Link>
                        {j.subtitle ? ` · ${j.subtitle}` : ""}
                        <span className="text-faint"> · {queuedCaption(j)}</span>
                      </li>
                    ))}
                    {pendingQueue.slice(0, 6).map((p) => (
                      <li key={p.input} className="truncate text-muted">
                        <span className="font-medium text-foreground">{p.title.replace(/^Score · /, "")}</span>
                        {p.subtitle ? ` · ${p.subtitle}` : ""}
                        <span className="text-faint"> · in your list</span>
                      </li>
                    ))}
                    {pendingQueue.length > 6 && (
                      <li className="text-faint">+{pendingQueue.length - 6} more in your list</li>
                    )}
                  </ul>
                )}
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Recent</p>
                {recentEvalJobs.length === 0 ? (
                  <p className="text-muted">Nothing finished yet</p>
                ) : (
                  <ul className="space-y-1">
                    {recentEvalJobs.map((j) => (
                      <li key={j.id} className="flex min-w-0 items-center gap-2">
                        <Link href={`/jobs/${j.id}`} className="min-w-0 flex-1 truncate text-muted hover:text-brand">
                          {j.title.replace(/^Score · /, "")}
                        </Link>
                        {j.status === "error" ? (
                          <span className="shrink-0 font-medium text-red-500">Failed</span>
                        ) : j.result?.score != null ? (
                          <span className="shrink-0 tabular-nums text-foreground">{j.result.score}/5</span>
                        ) : (
                          <span className="shrink-0 text-faint">Done</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <p className="mt-3 text-[11px] text-faint">
              {isOllama
                ? "Each score is a full AI evaluation (~5–8+ min on qwen3:8b). This account: one running and one waiting on the machine."
                : "Each score is a full AI evaluation (~1–3 min). This account: one running and one waiting on the machine."}{" "}
              Rows show <span className="text-muted">Evaluating… / Queued (position #) / score / Failed</span>.{" "}
              <Link href="/jobs" className="text-brand hover:underline">
                Full worker history →
              </Link>
            </p>
          </div>
        )}
      </div>

      <div className="min-w-0">
          <FacetChips
            within={within}
            setWithin={setWithin}
            postedOn={postedOn}
            setPostedOn={setPostedOn}
            sources={sources}
            toggleSource={(s) => setSources((set) => { const n = new Set(set); n.has(s) ? n.delete(s) : n.add(s); return n; })}
            seniorities={seniorities}
            toggleSeniority={(s) => setSeniorities((set) => { const n = new Set(set); n.has(s) ? n.delete(s) : n.add(s); return n; })}
            locQ={locQ}
            setLocQ={setLocQ}
            kw={kw}
            setKw={setKw}
            postedSort={postedSort}
            setPostedSort={setPostedSort}
            savedSearches={savedSearches}
            onSaveSearch={() => {
              const label =
                [kw.trim(), locQ.trim() || "any", postedOn || ""].filter(Boolean).join(" · ").slice(0, 48) ||
                "Saved search";
              const name =
                typeof window !== "undefined"
                  ? window.prompt("Name this search", label) || ""
                  : label;
              if (!name.trim()) return;
              const entry: SavedSearch = {
                id: `s-${Date.now()}`,
                name: name.trim().slice(0, 48),
                kw,
                locQ,
                within,
                postedOn,
                sources: [...sources],
                seniorities: [...seniorities],
                postedSort,
              };
              setSavedSearches((prev) => [entry, ...prev.filter((p) => p.name !== entry.name)].slice(0, 20));
            }}
            onApplySaved={(s) => {
              setKw(s.kw);
              setLocQ(s.locQ);
              setWithin(s.within);
              setPostedOn(
                typeof s.postedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.postedOn) ? s.postedOn : null,
              );
              setSources(new Set(s.sources));
              setSeniorities(new Set(s.seniorities));
              setPostedSort(
                s.postedSort === "asc" || s.postedSort === "match" || s.postedSort === "desc"
                  ? s.postedSort
                  : "desc",
              );
            }}
            onDeleteSaved={(id) => setSavedSearches((prev) => prev.filter((s) => s.id !== id))}
            availSources={availSources}
            availSeniorities={availSeniorities}
            resultCount={filtered.length}
            totalCount={enriched.length - hiddenCount}
            anyActive={anyFacet}
            onClear={() => {
              setWithin(null);
              setPostedOn(null);
              setSources(new Set());
              setSeniorities(new Set());
              setProfileFilter(new Set());
              setKw("");
              setPostedSort("desc");
              // Restore sticky location pref (default Israel) — don't make you retype it
              setLocQ(locPref || DEFAULT_LOC_PREF);
            }}
          />

          {/* M2: search-profile facet — filter the inbox by which isolated scan produced each row. */}
          {availProfileIds.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Profile</span>
              {availProfileIds.map((id) => {
                const on = profileFilter.has(id);
                const label = profileTitle.get(id) || id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() =>
                      setProfileFilter((s) => {
                        const next = new Set(s);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                    className={cn(
                      "shrink-0 rounded-full border px-2.5 text-xs font-medium transition-colors max-sm:min-h-[44px]",
                      on ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
                    )}
                    title={id}
                  >
                    {label}
                  </button>
                );
              })}
              {profileFilter.size > 0 && (
                <button
                  type="button"
                  onClick={() => setProfileFilter(new Set())}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
                >
                  <XIcon className="size-3" /> Clear profile
                </button>
              )}
            </div>
          )}

          {/* batch header: fresh slice by default, or the full filtered set */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
              <p className="text-sm font-medium text-foreground">
                {capped ? "Fresh — worth a look" : anyFacet ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}` : "All roles"}
                {postedOn ? <span className="font-normal text-muted"> · {postedOn}</span> : null}
              </p>
              {visible.length > 0 && (
                <button
                  type="button"
                  onClick={toggleSelectAllVisible}
                  className="rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand/15 max-sm:min-h-[44px]"
                  title="Select every row in the current filter (including already scored)"
                >
                  {allVisibleSelected ? "Deselect all" : `Select all ${visible.length}`}
                </button>
              )}
              {selectableVisible.length > 0 && selectableVisible.length < visible.length && (
                <button
                  type="button"
                  onClick={selectUnscoredOnly}
                  className="text-xs font-medium text-muted hover:text-brand hover:underline max-sm:min-h-[44px]"
                >
                  {allUnscoredSelected && selected.size === selectableVisible.length
                    ? "Deselect unscored"
                    : `Unscored only ${selectableVisible.length}`}
                </button>
              )}
              {visible.length > 0 && selectableVisible.length === 0 && (
                <span className="text-xs text-faint">All scored in this view</span>
              )}
            </div>
            {hiddenCount > 0 && (
              <button type="button" onClick={() => setHidden([])} className="text-xs text-faint transition-colors hover:text-foreground">
                {hiddenCount} hidden · restore
              </button>
            )}
          </div>

          {/* multi-select action bar — Score selected is the evaluate path; Save is shortlist only */}
          {selected.size > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-sm">
              <span className="font-medium text-brand tabular-nums">{selected.size} selected</span>
              <button
                type="button"
                disabled={!hasCli || selectedUnscoredCount === 0}
                onClick={scoreSelected}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
                title={
                  !hasCli
                    ? zeroKey
                      ? "Scoring runs in your own assistant — connect under Account → MCP"
                      : "Pick Claude or Ollama in Config first"
                    : selectedUnscoredCount === 0
                      ? "No unscored roles in selection (scored rows are skipped)"
                      : `Score ${selectedUnscoredCount} unscored`
                }
              >
                <Sparkles className="size-3.5" /> Score selected
                {selectedUnscoredCount ? ` (${selectedUnscoredCount})` : ""}
                {selected.size > selectedUnscoredCount ? (
                  <span className="font-normal opacity-80"> · {selected.size - selectedUnscoredCount} already scored</span>
                ) : null}
              </button>
              <button
                type="button"
                onClick={saveSelected}
                title="Bookmark for later scoring (bottom tray) — does not set Applied"
                className="rounded-md border border-brand/30 px-2.5 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]"
              >
                Add to shortlist
              </button>
              <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-muted hover:text-foreground max-sm:min-h-[44px]">
                Clear
              </button>
            </div>
          )}

          {visible.length > 0 ? (
            <ul className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
              {visible.map((e) => (
                <TriageRow
                  key={e.job.url}
                  job={e.job}
                  source={e.source}
                  age={e.age}
                  scored={scoreByUrl.get(normUrl(e.job.url))}
                  fit={postedSort === "match" ? e.fit : undefined}
                  fitHits={postedSort === "match" ? e.fitHits : undefined}
                  profileLabel={e.job.profileId ? profileTitle.get(e.job.profileId) || e.job.profileId : undefined}
                  selected={selected.has(e.job.url)}
                  active={false}
                  shortlisted={isShortlisted(e.job.url)}
                  selectable
                  onSelect={() => openRole(e.job)}
                  onToggleSelect={() => toggleSelect(e.job.url)}
                  onSave={() => save(e.job)}
                  onSkip={() => skip(e.job)}
                />
              ))}
            </ul>
          ) : (
            <div className="mt-3 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-10 text-center">
              <p className="font-display text-lg">No matches</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Loosen the filters to see more of your inbox.</p>
            </div>
          )}

          {/* "See all N" — only when the fresh batch is capping a larger list */}
          {capped && ordered.length > BATCH && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-3 inline-flex w-full items-center justify-center gap-1 rounded-xl border border-border bg-surface/40 py-2.5 text-sm font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
            >
              See all {ordered.length} in inbox →
            </button>
          )}

          {shortlist.length === 0 && (
            <p className="mt-4 text-center text-xs text-faint">
              Tip: click a role to open its page (status, score, Generate CV). Shortlist a few to batch-score.
            </p>
          )}
      </div>

      {/* undo toast (sits above the tray) */}
      {undo && (
        <div className={cn("fixed inset-x-0 z-40 flex justify-center px-4", shortlist.length > 0 ? "bottom-24 sm:bottom-24" : "bottom-6")}>
          <div className="inline-flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 text-sm shadow-lg">
            <span className="text-muted">{undo.label}</span>
            <button type="button" onClick={() => { undo.fn(); setUndo(null); }} className="inline-flex items-center gap-1 font-medium text-brand max-sm:min-h-[44px]">
              <Undo2 className="size-3.5" /> Undo
            </button>
          </div>
        </div>
      )}

      <ShortlistTray
        items={shortlist}
        estimate={shortlistEstimate}
        hasCli={hasCli}
        onRemove={(url) => setShortlist((s) => s.filter((x) => x.url !== url))}
        onClear={() => setShortlist([])}
        onScore={scoreShortlist}
      />
    </div>
  );
}
