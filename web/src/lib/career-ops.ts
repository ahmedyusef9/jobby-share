import fs from "node:fs";
import path from "node:path";
import { pickChildEnv } from "@/lib/child-env";
import { atomicWrite } from "@/lib/core/safe-write";
import { parseApplications } from "@/lib/tracker-table.mjs";
import { platformRoot, tenantId, tenantRoot } from "@/lib/tenant";

/** Env for spawned root scripts so they resolve the same tenant as this request. */
export function tenantScriptEnv(): NodeJS.ProcessEnv {
  return pickChildEnv({
    CAREER_OPS_ROOT: platformRoot(),
    JOBBY_TENANT_ID: tenantId(),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
  });
}

/**
 * Absolute path to a core root script (e.g. doctor, verify-portals). Scripts live
 * on the platform checkout, not inside a tenant tree.
 */
export function rootScript(nameNoExt: string): string {
  return path.join(platformRoot(), `${nameNoExt}.mjs`);
}

// Feature-detect the core's `tracker.mjs delete --num` row-delete (#1200) by probing
// the local script source — older checkouts lack it, so the delete UI hides itself.
export function trackerCanDelete(): boolean {
  try {
    const src = fs.readFileSync(rootScript("tracker"), "utf8");
    return src.includes("delete") && src.includes("--num");
  } catch {
    return false;
  }
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(tenantRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

export type InboxJob = { url: string; company: string; role: string; location?: string; compensation?: string; done: boolean; postedAt?: string; profileId?: string };

const POSTED_COL_RE = /^posted:\s*(\d{4}-\d{2}-\d{2})$/i;
// Search-profile tag (M2): `profile: sp_xxx` — which isolated scan produced the row.
const PROFILE_COL_RE = /^profile:\s*(sp_[a-z0-9]+)$/i;

/** Parse data/pipeline.md — `- [ ] URL | Company | Role [| Location [| Compensation]]`.
 *  Positional split (NOT a greedy trailing group): the optional 4th `location`
 *  (#1015) and 5th `compensation` (#1017) columns must NOT bleed into `role`;
 *  any further trailing columns are ignored gracefully.
 *  A trailing `posted: YYYY-MM-DD` column (from local parsers) becomes postedAt.
 *  A trailing `profile: sp_xxx` column (M2 search profiles) becomes profileId. */
export function readInbox(): InboxJob[] {
  const md = read("data/pipeline.md");
  if (!md) return [];
  const jobs: InboxJob[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const parts = m[2].split("|").map((s) => s.trim());
    if (parts.length < 3 || !parts[0]) continue; // need at least url | company | role

    let postedAt: string | undefined;
    let profileId: string | undefined;
    const rest: string[] = [];
    for (let i = 3; i < parts.length; i++) {
      const pm = parts[i].match(POSTED_COL_RE);
      const pf = parts[i].match(PROFILE_COL_RE);
      if (pm) postedAt = pm[1];
      else if (pf) profileId = pf[1];
      else rest.push(parts[i]);
    }

    jobs.push({
      done: m[1].toLowerCase() === "x",
      url: parts[0],
      company: parts[1],
      role: parts[2],
      location: rest[0] || undefined,
      compensation: rest[1] || undefined,
      postedAt,
      profileId,
    });
  }
  return jobs;
}

/**
 * Read data/scan-history.tsv → Map<url, first_seen(YYYY-MM-DD)>. The scanner
 * already stamps every discovered posting with the date it was first seen
 * (col 2), so we derive the inbox's freshness signal here WITHOUT touching the
 * core (see the inbox-triage build: freshness = option A, no scanner change).
 * Tolerant by construction: no file → empty map (freshness facet just hides);
 * a malformed row is skipped, never thrown (missing ≠ corrupt).
 */
export function readScanDates(): Map<string, string> {
  const tsv = read("data/scan-history.tsv");
  const dates = new Map<string, string>();
  if (!tsv) return dates;
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue; // skip header
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const url = line.slice(0, tab);
    const firstSeen = line.slice(tab + 1).split("\t")[0]?.trim();
    // keep the EARLIEST first_seen if a url recurs (it's "first" seen, after all)
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(url)) dates.set(url, firstSeen);
  }
  return dates;
}

/** One row from data/scan-history.tsv (url, first_seen, portal, title, company, status, location). */
export type ScanHit = {
  url: string;
  firstSeen: string;
  portal: string;
  title: string;
  company: string;
  status: string;
  location: string;
};

function normPostingUrl(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/** Latest scan-history row for a posting URL (case/host-normalized). Free — no tokens. */
export function findScanHit(wantUrl: string): ScanHit | null {
  const tsv = read("data/scan-history.tsv");
  if (!tsv || !wantUrl) return null;
  const want = normPostingUrl(wantUrl);
  let best: ScanHit | null = null;
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue;
    const c = line.split("\t");
    const url = (c[0] || "").trim();
    if (!url || normPostingUrl(url) !== want) continue;
    best = {
      url,
      firstSeen: (c[1] || "").trim(),
      portal: (c[2] || "").replace(/-full$/, "").trim(),
      title: (c[3] || "").trim(),
      company: (c[4] || "").trim(),
      status: (c[5] || "").trim(),
      location: (c[6] || "").trim(),
    };
  }
  return best;
}

export type Application = {
  n: string;
  date: string;
  company: string;
  /** Intermediary channel (#1596): agency/recruiter firm, "—" for direct, "" when the tracker has no Via column. */
  via: string;
  role: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
};

/**
 * Parse data/applications.md — the tracker table (source of truth).
 * The header-aware parsing lives in tracker-table.mjs, which resolves headers
 * through the SAME alias table the Node tooling uses (tracker-aliases.json,
 * exported by tracker-parse.mjs as HEADER_ALIASES) — one shared source, no
 * web-side mirror to drift (#954, PR #1598 review).
 */
export function readApplications(): Application[] {
  const md = read("data/applications.md");
  if (!md) return [];
  // Aliases live on the platform volume (tracker-aliases.json), not under
  // tenants/<id>/. Passing tenantRoot() makes detectColumnMap miss Via and
  // fall back to legacy column order — Status becomes Score (N/A), Evaluated
  // filters return 0, dashboard tabs look empty.
  return parseApplications(md, platformRoot());
}

/**
 * Server-side lifecycle of the user's setup — mirrors the prerequisite list that
 * doctor.mjs uses (cv.md, config/profile.yml, modes/_profile.md, portals.yml), by
 * plain file-stat (no subprocess). Drives the home branch: first-run (no CV) →
 * the CV takeover; in-between (CV but no profile) → gentle nudges; established.
 */
export type LifecyclePhase = "first-run" | "in-between" | "established";
/**
 * Server-side lifecycle, mirroring the core doctor.mjs prerequisite list with the
 * SAME existsSync semantics (the SSOT the OnboardingBanner already reads via
 * /api/doctor). The 4 user-layer prereqs: cv.md, config/profile.yml,
 * modes/_profile.md, portals.yml.
 *   - first-run  → a TRULY empty install (no cv AND no data): the CV takeover.
 *     CRITICAL back-compat (maintainer): NEVER force onboarding on a user who
 *     already has data (a full pipeline/tracker with no cv.md is valid).
 *   - in-between → has cv/data but setup incomplete: dashboard + the nudge banner.
 *   - established → all 4 prereqs present.
 * onboardingNeeded mirrors doctor.mjs: true if ANY prereq is missing → show banner.
 */
export function doctorState(): {
  phase: LifecyclePhase;
  onboardingNeeded: boolean;
  missing: string[];
  hasCv: boolean;
  hasData: boolean;
} {
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(tenantRoot(), rel));
    } catch {
      return false;
    }
  };
  const prereqs: [string, string][] = [
    ["cv.md", "cv.md"],
    ["config/profile.yml", "config/profile.yml"],
    ["modes/_profile.md", "modes/_profile.md"],
    ["portals.yml", "portals.yml"],
  ];
  const missing = prereqs.filter(([rel]) => !has(rel)).map(([, label]) => label);
  const hasCv = has("cv.md");
  const hasData = readApplications().length > 0 || readInbox().some((j) => !j.done);
  const onboardingNeeded = missing.length > 0;
  const phase: LifecyclePhase = !hasCv && !hasData ? "first-run" : onboardingNeeded ? "in-between" : "established";
  return { phase, onboardingNeeded, missing, hasCv, hasData };
}

export type PipelineSummary = {
  root: string;
  rootExists: boolean;
  inbox: InboxJob[];
  applications: Application[];
  /** posting URL -> report number, so the inbox can badge a role with its
   *  persisted tracker score after the live worker has aged out. */
  reportUrls: { url: string; n: string }[];
};

export function pipelineSummary(): PipelineSummary {
  const root = tenantRoot();
  const scanDates = readScanDates();
  return {
    root,
    rootExists: fs.existsSync(root),
    // join the freshness date (first_seen) onto each raw posting — the inbox's
    // triage view orders/faceted-filters on it entirely client-side.
    inbox: readInbox().map((j) => ({ ...j, postedAt: j.postedAt || scanDates.get(j.url) })),
    applications: readApplications(),
    reportUrls: reportUrlIndex(),
  };
}

export type ReportData = { content: string; file: string };

/** Locate the evaluation report for an application number
 *  (reports/{n}-{slug}-{date}.md; the leading number may be zero-padded).
 *  Skip `{n}-RESERVED.md` sentinels from reserve-report-num.mjs — those are
 *  lock tokens (JSON), not evaluations, and alphabetically sort BEFORE the real
 *  report so a naïve `.find()` would serve garbage to /pipeline/{n}. */
export function findReportFile(n: string): string | null {
  const target = parseInt(n, 10);
  if (Number.isNaN(target)) return null;
  let files: string[];
  try {
    files = fs.readdirSync(path.join(tenantRoot(), "reports"));
  } catch {
    return null;
  }
  const match = files.find(
    (f) =>
      f.endsWith(".md") &&
      !/-RESERVED\.md$/i.test(f) &&
      parseInt(f, 10) === target,
  );
  return match ? path.join(tenantRoot(), "reports", match) : null;
}

export function readReport(n: string): ReportData | null {
  const file = findReportFile(n);
  if (!file) return null;
  try {
    return { content: fs.readFileSync(file, "utf8"), file: path.basename(file) };
  } catch {
    return null;
  }
}

export function findApplication(n: string): Application | null {
  const target = parseInt(n, 10);
  return readApplications().find((a) => parseInt(a.n, 10) === target) ?? null;
}

const REPORT_URL_RE = /^\*\*URL:\*\*\s*(\S+)/im;
const NOTES_URL_RE = /(?:url=)?(https?:\/\/[^\s|]+)/gi;

/** First http(s) URL in tracker notes (`url=…` or bare). Manual adds store the posting here. */
export function urlFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  NOTES_URL_RE.lastIndex = 0;
  const m = NOTES_URL_RE.exec(notes);
  return m?.[1] && /^https?:\/\//i.test(m[1]) ? m[1] : null;
}

/** Map each evaluation report that carries a posting URL to its report number.
 *  Also picks up `url=…` (or bare https) in tracker Notes — used when a row was
 *  added from the inbox without an A–F report (manual Applied / Discarded / SKIP).
 *  The tracker's Application has no URL column, so these are the keys that
 *  survive a reload for inbox ↔ tracker join. */
export function reportUrlIndex(): { url: string; n: string }[] {
  let files: string[];
  try {
    files = fs.readdirSync(path.join(tenantRoot(), "reports"));
  } catch {
    files = [];
  }
  const out: { url: string; n: string }[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.endsWith(".md") || /-RESERVED\.md$/i.test(f)) continue;
    const num = parseInt(f, 10);
    if (Number.isNaN(num)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(tenantRoot(), "reports", f), "utf8");
    } catch {
      continue;
    }
    const m = content.match(REPORT_URL_RE);
    if (m && /^https?:\/\//i.test(m[1]) && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ url: m[1], n: String(num) });
    }
  }
  for (const a of readApplications()) {
    const notes = a.notes || "";
    if (!notes) continue;
    NOTES_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NOTES_URL_RE.exec(notes)) !== null) {
      const u = m[1];
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push({ url: u, n: a.n });
    }
  }
  return out;
}

/** The CANONICAL user-customization file the CLI/TUI reads. Durable facts the
 *  web assistant learns go HERE (single source of truth) inside a managed marker
 *  block — so the CLI sees them too. No web-only memory store (that would drift). */
export function profilePath(): string {
  return path.join(tenantRoot(), "modes", "_profile.md");
}

const NOTES_START = "<!-- co-web-notes:start -->";
const NOTES_END = "<!-- co-web-notes:end -->";

/** Read back ONLY the web-assistant managed notes from modes/_profile.md (small,
 *  focused — the agent reads the rest of the canonical files itself). Falls back
 *  to the legacy web-only memory file for back-compat. */
export function readMemory(): string {
  try {
    const md = fs.readFileSync(profilePath(), "utf8");
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) return md.slice(i + NOTES_START.length, j).trim();
  } catch {
    /* no _profile.md yet */
  }
  try {
    return fs.readFileSync(path.join(tenantRoot(), ".career-ops-web", "memory.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Append a durable fact to the canonical modes/_profile.md (creating the file +
 *  managed block if needed), PRESERVING existing user content. */
export function rememberFact(fact: string): "ok" | "deduped" | "error" {
  const f = fact.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!f) return "deduped";
  const p = profilePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let md = "";
    try {
      md = fs.readFileSync(p, "utf8");
    } catch {
      md = "";
    }
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) {
      if (md.slice(i, j).includes(f)) return "deduped";
      atomicWrite(p, md.slice(0, j) + `- ${f}\n` + md.slice(j));
      return "ok";
    }
    if (md.includes(f)) return "deduped";
    const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
    const base = md.trim() ? md.replace(/\n*$/, "\n") : "# Profile customization\n";
    atomicWrite(p, base + section);
    return "ok";
  } catch {
    return "error";
  }
}
