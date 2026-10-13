import fs from "node:fs";
import path from "node:path";
import { pipelineSummary, readReport, rootScript, tenantScriptEnv } from "@/lib/career-ops";
import { runNodeScript } from "@/lib/core/run-node-script";
import { addOffersToPipeline } from "@/lib/core/pipeline";
import { runDiscovery } from "@/lib/core/scan";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { currentAccount, planLimits, can, CAP, denialReason, isOperator } from "@/lib/entitlements";
import {
  ATS_SOURCES,
  DEFAULT_FILTERS,
  parseExplorePatch,
  type AtsSource,
  type DiscoveredOffer,
} from "@/lib/explore";
import { mcpUsageToday } from "@/lib/mcp-quota";
import { tenantId, tenantRoot } from "@/lib/tenant";
import { getProfile, listProfiles } from "@/lib/core/search-profiles";
import { addManualApplication, deleteApplication, normalizeTrackerScore, searchApplications, trackerStatusCounts, updateApplicationStatus, updateJobPosting, urlFromNotes } from "@/lib/tracker-mutate";
import { toolTextResult } from "@/lib/mcp-jsonrpc";
import { formatMcpJobCard, mcpJobListResponse, renderJobDetailBlock, renderJobsTableBlock } from "@/lib/mcp/job-card";
import {
  MCP_OUTPUT_CONTRACT,
  MCP_OUTPUT_CONTRACT_SHORT,
  hasMcpOutputSection,
} from "@/lib/mcp-output-contract";
import { generateCvPdf } from "@/lib/cv/export-core";
import { signResumeLink } from "../../../../scripts/resume-links.mjs";
import { checkLivenessViaApi, isAtsPosting } from "../../../../liveness-api.mjs";

const MAX_CV = 200_000;
const MAX_RULES = 400_000;

/** Recent explore captures so get_job can return full JD after a search (process-local). */
type CachedJob = {
  company: string;
  title: string;
  location?: string;
  postedAt?: string;
  source?: string;
  summary?: string;
  description?: string;
};
const recentJobByKey = new Map<string, CachedJob>();
const RECENT_JOB_CAP = 250;

function recentJobKey(url: string) {
  return `${tenantId()}:${url}`;
}

function rememberExploreJobs(jobs: Array<ReturnType<typeof formatMcpJobCard>>) {
  for (const j of jobs) {
    const url = j.links?.posting;
    if (!url) continue;
    const key = recentJobKey(url);
    if (recentJobByKey.has(key)) recentJobByKey.delete(key);
    recentJobByKey.set(key, {
      company: j.company,
      title: j.title,
      location: j.location || undefined,
      postedAt: j.postedAt || undefined,
      source: j.source || undefined,
      summary: j.summary,
      description: j.description,
    });
    while (recentJobByKey.size > RECENT_JOB_CAP) {
      const oldest = recentJobByKey.keys().next().value;
      if (oldest == null) break;
      recentJobByKey.delete(oldest);
    }
  }
}

type Json = Record<string, unknown>;

export const MCP_TOOLS = [
  {
    name: "whoami",
    description: "This tenant: plan, remaining scan and MCP quota for today.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_resume",
    description: "Read cv.md for this tenant. Empty string if they have not saved a resume yet.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_resume",
    description:
      "Replace cv.md. Pass the full markdown. Extract from a pasted CV yourself, then save here. Invent nothing.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "resume_update",
    description:
      "Patch cv.md with a literal find→replace (first occurrence). `find` must appear in the current cv.md exactly as given. For full rewrites use update_resume.",
    inputSchema: {
      type: "object",
      properties: {
        find: { type: "string", description: "Exact text currently in cv.md" },
        replace_with: { type: "string" },
      },
      required: ["find", "replace_with"],
      additionalProperties: false,
    },
  },
  {
    name: "resume_upload",
    description:
      "Store a resume file for this tenant, replacing the previous one. Pass `content` (markdown → becomes cv.md) or `content_pdf_base64` (≤5 MB → uploads/resume.pdf).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full markdown CV" },
        content_pdf_base64: { type: "string", description: "Base64 of a PDF file" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "resume_download_link",
    description:
      "Short-lived signed URL (~15 min) to the resume for sharing in chat. format 'md' → cv.md; 'pdf' → newest exported PDF under output/. Opens in a bare browser — no session or key needed.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["md", "pdf"] } },
      additionalProperties: false,
    },
  },
  {
    name: "resume_generate",
    description:
      "Render cv.md to a clean PDF through Chromium — deterministic, no AI model call. Returns metadata plus a signed download link (~15 min).",
    inputSchema: {
      type: "object",
      properties: { max_pages: { type: "number", enum: [1, 2] } },
      additionalProperties: false,
    },
  },
  {
    name: "jobs_fetch",
    description:
      `This tenant's STORED jobs as ONE markdown table (Company, Role, Location, Posted, Status, Score, Posting, Jobby). source 'inbox' = saved pipeline, 'tracker' = applications, 'all' = both newest-first. Filters: status (tracker), from/to (YYYY-MM-DD on the row date). ${MCP_OUTPUT_CONTRACT_SHORT}`,
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["all", "inbox", "tracker"], description: "default all" },
        status: { type: "string", description: "tracker status filter, e.g. Applied, Interview" },
        from: { type: "string", description: "YYYY-MM-DD inclusive" },
        to: { type: "string", description: "YYYY-MM-DD inclusive" },
        limit: { type: "number", description: "default 50, max 200" },
        offset: { type: "number", description: "default 0" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "submit_score",
    description:
      "Write YOUR fit score for a stored job back to jobby. score 0–5 (one decimal; 0–100 is auto-converted). scored_by is REQUIRED provenance naming the model that produced it, e.g. 'openai/gpt-5.2'. Idempotent: re-submitting an identical score+scored_by changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Tracker row number (from jobs_fetch Jobby link or list_applications)" },
        url: { type: "string", description: "Posting URL (alternative to job_id)" },
        company: { type: "string", description: "Company + role (alternative identifier)" },
        role: { type: "string" },
        score: { type: "number", description: "0–5 fit score (or 0–100)" },
        rationale: { type: "string", description: "One short line of reasoning stored with the score" },
        scored_by: { type: "string", description: "REQUIRED provenance: provider/model id" },
      },
      required: ["score", "scored_by"],
      additionalProperties: false,
    },
  },
  {
    name: "explore_jobs",
    description:
      `Search live boards. Returns ONE markdown table (Company, Role, Location, Posted, Posting, Jobby) plus Briefs. ${MCP_OUTPUT_CONTRACT_SHORT} Prompts: table | score | last_24h. Pass profile_id to run one tenant search profile's isolated query.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Role keywords, comma-separated" },
        exclude: { type: "string", description: "Title words to drop" },
        location: { type: "string", description: "City or region (Only-in)" },
        country: { type: "string", description: "Israel, Germany, USA, UK, …" },
        distance_km: { type: "number", description: "Radius from location; 0 = any" },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "greenhouse, lever, ashby, workday, drushim, linkedin",
        },
        since_days: { type: "number" },
        limit: { type: "number", description: "Max results per source" },
        profile_id: { type: "string", description: "Tenant search profile id (sp_xxx) — runs that profile's queries/locations instead of the ad-hoc args." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "job_table",
    description:
      `Built-in "@jobby table …" search. Same as explore_jobs. ${MCP_OUTPUT_CONTRACT_SHORT}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Role keywords, comma-separated" },
        exclude: { type: "string", description: "Title words to drop" },
        location: { type: "string", description: "City or region (Only-in)" },
        country: { type: "string", description: "Israel, Germany, USA, UK, …" },
        distance_km: { type: "number", description: "Radius from location; 0 = any" },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "greenhouse, lever, ashby, workday, drushim, linkedin",
        },
        since_days: { type: "number" },
        limit: { type: "number", description: "Max results per source" },
        profile_id: { type: "string", description: "Tenant search profile id (sp_xxx) — runs that profile's queries/locations instead of the ad-hoc args." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "save_jobs",
    description: "Append chosen postings to the pipeline inbox (data/pipeline.md). Not the tracker. Pass profile_id to tag the rows with the search profile that produced them.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "string", description: "Search profile id (sp_xxx) that produced these jobs — stamps `profile:` on each pipeline row." },
        jobs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              company: { type: "string" },
              title: { type: "string" },
              location: { type: "string" },
              source: { type: "string" },
            },
            required: ["url", "company", "title"],
          },
        },
      },
      required: ["jobs"],
      additionalProperties: false,
    },
  },
  {
    name: "list_inbox",
    description:
      "Pending pipeline jobs as a markdown table (Posting + Jobby links). Filter with query (company/role), source (greenhouse, lever, ashby, workday, linkedin, drushim), and/or location. Display verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        query: { type: "string", description: "Match against company or role" },
        source: { type: "string", description: "ATS/board source, e.g. greenhouse, lever, ashby, workday, linkedin, drushim" },
        location: { type: "string", description: "Substring match against the posting's location" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_applications",
    description:
      "Tracker rows as a markdown table. Pass status (e.g. Evaluated), query text, or company. Paginate with limit/offset; filter by date with from/to (YYYY-MM-DD); pass include_notes to add the Notes column. Footer includes tenantId + counts — if the dashboard looks empty, compare tenantId to Account.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        query: { type: "string", description: "Search company, role, notes, score" },
        company: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number", description: "Skip this many matching rows before the page starts (default 0)" },
        from: { type: "string", description: "Only rows on/after this date (YYYY-MM-DD)" },
        to: { type: "string", description: "Only rows on/before this date (YYYY-MM-DD)" },
        include_notes: { type: "boolean", description: "Add a Notes column to the table" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_applications",
    description: "Alias of list_applications — query/search the tracker (status, company, free text, date range, pagination).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        query: { type: "string" },
        company: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number", description: "Skip this many matching rows before the page starts (default 0)" },
        from: { type: "string", description: "Only rows on/after this date (YYYY-MM-DD)" },
        to: { type: "string", description: "Only rows on/before this date (YYYY-MM-DD)" },
        include_notes: { type: "boolean", description: "Add a Notes column to the table" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_followups",
    description:
      "Which tracker rows need a follow-up today — company, role, status, last contact date, due date, days overdue. Runs the same cadence calculator as the CLI/dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        overdue_only: { type: "boolean", description: "Only rows that are overdue or urgent (default false — all actionable rows)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "company_history",
    description:
      "Every tracker row for one company (role, status, score, notes, date), plus responsiveness/posting-churn context from company-history.mjs — full picture before an interview.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string", description: "Company name (substring match, same as list_applications' company filter)" },
      },
      required: ["company"],
      additionalProperties: false,
    },
  },
  {
    name: "check_liveness",
    description:
      "Is this posting still open? Checks the posting's ATS API directly (Greenhouse, Lever, Ashby, …) — zero-browser, fast. Non-ATS URLs return state:unknown (this deployment has no page renderer available for read-tool calls). Never throws.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The job posting URL" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "get_report",
    description:
      "Read the full A–F evaluation report body for a tracker row, exactly as shown at /report/n in the UI. Returns a clear not-found message for an unknown report number — never throws.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "string", description: "Report number (matches the tracker # column)" },
      },
      required: ["n"],
      additionalProperties: false,
    },
  },
  {
    name: "pipeline_stats",
    description: "Tracker funnel counts — total rows plus a breakdown by status. Matches the /pipeline tab badges exactly.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "add_application",
    description:
      "Add or update a tracker row. Status: Applied, Discarded, SKIP, Evaluated, Rejected. Optional score as X.X/5 (or N/100 — converted). Notes/score update existing rows (same company+role or url).",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string" },
        role: { type: "string" },
        url: { type: "string" },
        status: { type: "string" },
        notes: { type: "string" },
        score: { type: "string", description: "X.X/5 preferred; N/100 accepted and converted" },
      },
      required: ["company", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "update_application",
    description: "Set canonical status on tracker row(s) by number.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "string" },
        ns: { type: "array", items: { type: "string" } },
        status: { type: "string" },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
  {
    name: "update_job",
    description:
      "Update an existing posting: status, score (X.X/5), and/or notes. Find by n, url, or company+role.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "string" },
        url: { type: "string" },
        company: { type: "string" },
        role: { type: "string" },
        status: { type: "string" },
        score: { type: "string" },
        notes: { type: "string" },
        append_notes: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "remove_application",
    description: "Delete one tracker row by number. Irreversible.",
    inputSchema: {
      type: "object",
      properties: { n: { type: "string" } },
      required: ["n"],
      additionalProperties: false,
    },
  },
  {
    name: "get_job",
    description: "One job as a markdown table row plus full Description when captured. Display verbatim.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, n: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_rules",
    description:
      "House rules (modes/_custom.md) plus the Jobby MCP output contract. Persist contract with update_rules under ## MCP job search output.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_rules",
    description: "Replace modes/_custom.md. Procedural/style rules only — no factual claims about the person.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "export_snapshot",
    description: "Return cv.md, rules, tracker, and pipeline as text. Keys are never included.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

function jsonText(value: unknown, isError = false) {
  return toolTextResult(JSON.stringify(value, null, 2), isError);
}

/** Markdown table cell: escape pipes/newlines, empty → em dash. */
function mdCell(s: unknown) {
  return String(s ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ").trim() || "—";
}

/**
 * Classify a posting URL's hostname into one of ATS_SOURCES. Mirrors the
 * greenhouse/lever/ashby hostname patterns already used by liveness-api.mjs's
 * ATS_PROVIDERS (kept independent here since that file matches strict per-job
 * paths for building an API call, not just "which vendor is this").
 * Returns null for an unrecognized host — never a guess.
 */
function atsSourceFromUrl(url: string): AtsSource | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/(^|\.)greenhouse\.io$/.test(hostname)) return "greenhouse";
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(hostname)) return "lever";
  if (hostname === "jobs.ashbyhq.com") return "ashby";
  if (/myworkdayjobs\.com$/.test(hostname)) return "workday";
  if (/(^|\.)linkedin\.com$/.test(hostname)) return "linkedin";
  if (/(^|\.)drushim\.co\.il$/.test(hostname)) return "drushim";
  return null;
}

/** Job tools return one markdown table — fit/score belongs below it, not in a second table. */
function jobListText(
  jobs: Array<Record<string, unknown>>,
  title: string,
  opts: {
    tracker?: boolean;
    includeNotes?: boolean;
    meta?: Record<string, unknown>;
    includeContractNote?: boolean;
  } = {},
) {
  return toolTextResult(renderJobsTableBlock(jobs, title, opts));
}

function readTenantFile(rel: string): string {
  try {
    return fs.readFileSync(path.join(tenantRoot(), rel), "utf8");
  } catch {
    return "";
  }
}

function writeTenantFile(rel: string, content: string, maxBytes: number, label: string) {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(`${label} is too large`);
  }
  const file = path.join(tenantRoot(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteWithBackup(file, content);
}

const MAX_RESUME_PDF = 5 * 1024 * 1024;

/** Newest PDF under the tenant's output/ directory, or null. */
function latestTenantPdf(): string | null {
  const dir = path.join(tenantRoot(), "output");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    return null;
  }
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return `output/${files[0]}`;
}

/**
 * Public base URL for signed links; empty → return the bare path (BL-086).
 *
 * JOBBY_APP_PUBLIC_URL first, not JOBBY_MCP_PUBLIC_URL: per .ports.yml, the
 * Funnel/Serve split routes only /mcp /api/mcp /sse /.well-known at :443
 * (JOBBY_MCP_PUBLIC_URL's origin, no port) — everything else there, including
 * /api/resume/*, falls through to a DIFFERENT service (OmniRoute), which is
 * exactly the {"error":"not found"} Round 7 QA saw. :8443/:8444
 * (JOBBY_APP_PUBLIC_URL) proxy the whole app wholesale, so that's the origin
 * a signed download link actually needs. Same precedence as
 * mcpDashboardOrigin() in scripts/mcp-job-card.mjs.
 */
function publicBaseUrl(): string {
  const candidates = [process.env.JOBBY_APP_PUBLIC_URL, process.env.JOBBY_MCP_PUBLIC_URL, process.env.NEXT_PUBLIC_APP_URL];
  for (const raw of candidates) {
    const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    } catch {
      // not a valid absolute URL — try the next candidate
    }
  }
  return "";
}

function signedLinkFor(relFile: string): { url: string; expires_at: string } {
  const { token, expiresAt } = signResumeLink({ tenantId: tenantId(), file: relFile });
  const local = `/api/resume/${token}`;
  const base = publicBaseUrl();
  return { url: base ? `${base}${local}` : local, expires_at: expiresAt };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** First YYYY-MM-DD found in a raw date-ish string, or null. */
function rowDate(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return DATE_RE.test(s) ? s.slice(0, 10) : null;
}

/**
 * jobs_fetch — the stored-jobs feed (BL-056). Reads only this tenant's saved
 * pipeline + tracker; never the live boards (that is explore_jobs). Rows are
 * newest-first by their own date, and the table is the verbatim contract
 * block so every client renders it identically.
 */
async function jobsFetch(args: Json): Promise<ReturnType<typeof toolTextResult>> {
  const source = String(args.source ?? "all").toLowerCase();
  if (!["all", "inbox", "tracker"].includes(source)) {
    return jsonText({ error: "source must be all | inbox | tracker" }, true);
  }
  const status = String(args.status ?? "").trim().toLowerCase();
  const from = rowDate(args.from);
  const to = rowDate(args.to);
  if (args.from && !from) return jsonText({ error: "from must be YYYY-MM-DD" }, true);
  if (args.to && !to) return jsonText({ error: "to must be YYYY-MM-DD" }, true);
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
  const offset = Math.max(Number(args.offset) || 0, 0);

  type Row = { card: Record<string, unknown>; date: string | null; tracker: boolean };
  const rows: Row[] = [];

  if (source === "tracker" || source === "all") {
    // status filter applies to tracker rows only — inbox rows have no status.
    const found = searchApplications({ status: source === "tracker" ? status : "", limit: 200 });
    for (const a of found.rows) {
      rows.push({
        tracker: true,
        date: rowDate((a as { date?: string }).date),
        card: formatMcpJobCard({
          kind: "application",
          company: a.company,
          title: a.role,
          role: a.role,
          url: urlFromNotes(a.notes),
          n: a.n,
          status: a.status,
          score: a.score,
          notes: a.notes,
          postedAt: rowDate((a as { date?: string }).date) ?? undefined,
        }) as unknown as Record<string, unknown>,
      });
    }
  }
  if (source === "inbox" || source === "all") {
    const s = pipelineSummary();
    for (const j of s.inbox) {
      rows.push({
        tracker: false,
        date: rowDate(j.postedAt),
        card: formatMcpJobCard({
          kind: "inbox",
          company: j.company,
          title: j.role,
          role: j.role,
          location: j.location,
          postedAt: j.postedAt,
          url: j.url,
        }) as unknown as Record<string, unknown>,
      });
    }
  }

  const filtered = rows.filter((r) => {
    if (from && (!r.date || r.date < from)) return false;
    if (to && (!r.date || r.date > to)) return false;
    return true;
  });
  filtered.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const page = filtered.slice(offset, offset + limit);

  const titleBits = [
    source !== "all" ? source : "inbox+tracker",
    status || "",
    from || to ? `${from ?? "…"}→${to ?? "…"}` : "",
  ].filter(Boolean);
  const title = `Jobs · ${titleBits.join(" · ")}`;

  // Full tracker schema always (Status + Score columns), contract note and
  // meta footer suppressed — bare verbatim table (QA round 2, #52).
  return jobListText(
    page.map((r) => r.card),
    title,
    { tracker: true, includeContractNote: false },
  );
}

/**
 * submit_score — external-AI score write-back (BL-057). The scoring model is
 * the user's own assistant; jobby only stores the verdict. Provenance
 * (`scored_by`) is mandatory so a score can always be traced to the model that
 * produced it. Resolution and write are tenant-scoped by construction: rows
 * come from this tenant's tracker file, so a foreign job_id cannot resolve.
 */
function submitScore(args: Json): ReturnType<typeof toolTextResult> {
  const scoredBy = String(args.scored_by ?? "").trim();
  if (!scoredBy) {
    return jsonText(
      { error: "scored_by is required — provenance of the model that produced this score (e.g. 'openai/gpt-5.2')" },
      true,
    );
  }
  if (scoredBy.length > 120) return jsonText({ error: "scored_by too long (max 120 chars)" }, true);

  const normalized = normalizeTrackerScore(args.score != null ? String(args.score) : "");
  if (!normalized) {
    return jsonText({ error: "score must be numeric, 0–5 (or 0–100, auto-converted)" }, true);
  }

  const n = args.job_id != null ? String(args.job_id) : args.n != null ? String(args.n) : "";
  const url = String(args.url ?? "").trim();
  const company = String(args.company ?? "").trim();
  const role = String(args.role ?? "").trim();
  if (!n && !url && !(company && role)) {
    return jsonText({ error: "identify the job: job_id (tracker row number), url, or company+role" }, true);
  }

  const rows = searchApplications({ limit: 200 }).rows;
  const target = n
    ? rows.find((a) => String(parseInt(a.n, 10)) === String(parseInt(n, 10)))
    : rows.find((a) =>
        url
          ? urlFromNotes(a.notes) === url
          : a.company.toLowerCase() === company.toLowerCase() && a.role.toLowerCase() === role.toLowerCase(),
      );
  if (!target) {
    return jsonText(
      { error: "job not found in this tenant's tracker — save it first via save_jobs or add_application" },
      true,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const provLine = scrubProvenance(`[scored-by: ${scoredBy} · ${normalized} · ${today}]`);
  const rationale = String(args.rationale ?? "").trim();

  // Idempotent re-submit ONLY on a clean state: exactly one WELL-FORMED tag
  // (closed brackets - a truncated "[scored-by: o" fragment does not count)
  // from this model, unchanged score, no rationale to add. Anything dirty
  // falls through to a rewrite, which is what cleans it up.
  const tags = String(target.notes ?? "").match(/\[scored-by:[^\]]*\]/g) ?? [];
  const mine = tags.filter((t) => t.startsWith(`[scored-by: ${scoredBy}`));
  if (
    (target.score ?? "").trim() === normalized &&
    tags.length === 1 &&
    mine.length === 1 &&
    rationale === ""
  ) {
    return jsonText({
      ok: true,
      updated: false,
      idempotent: true,
      job_id: target.n,
      company: target.company,
      role: target.role,
      score: normalized,
      scored_by: scoredBy,
    });
  }

  // Rewrite provenance in place: drop ANY older [scored-by fragment (including
  // ones truncated by the old 200-char cap) so exactly one clean tag remains.
  const keptNotes = String(target.notes ?? "")
    .replace(/\[scored-by:[^\]]*\]?/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:^|\s)·(?=\s|$)/g, "")
    .trim();
  // Provenance goes FIRST so the 400-char cell cap can never eat the tag;
  // older note text fills whatever budget remains.
  const provWithRationale = rationale ? `${provLine} ${rationale}` : provLine;
  const budget = Math.max(400 - provWithRationale.length - 3, 0);
  const newNote = [provWithRationale, keptNotes.slice(0, budget).trim()]
    .filter(Boolean)
    .join(" · ");

  const result = updateJobPosting({
    n: target.n,
    score: normalized,
    notes: newNote,
  });

  return jsonText({
    ok: Boolean(result.ok),
    updated: result.ok,
    job_id: target.n,
    company: target.company,
    role: target.role,
    score: normalized,
    scored_by: scoredBy,
    provenance_note: provLine,
    ...(result.ok ? {} : { error: "write failed" }),
  });
}

/** Notes cells are scrubbed downstream too; keep provenance within their limits. */
function scrubProvenance(s: string): string {
  return s.replace(/[|\r\n\t*#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

async function whoami() {
  const account = currentAccount();
  const limits = planLimits(account);
  const mcp = await mcpUsageToday(tenantId(), account);
  const counts = trackerStatusCounts();
  // R4: expose the active search profiles + the effective query so a connected
  // assistant can explain which tenant/profile it is using. Profiles supersede
  // portals.yml as the query source when at least one is enabled.
  const profiles = listProfiles(tenantRoot());
  const activeProfiles = profiles.filter((p) => p.enabled);
  const effectiveQuery = {
    positive: dedupeCaseInsensitive(activeProfiles.flatMap((p) => p.queries)),
    locations: dedupeCaseInsensitive(activeProfiles.flatMap((p) => p.locations)),
  };
  return {
    tenantId: tenantId(),
    plan: account.plan ?? "alpha",
    role: account.role ?? "member",
    limits: limits ?? { scans: null, mcp: null, results: null, priceUsd: 0 },
    mcpToday: mcp,
    tracker: counts,
    searchProfiles: {
      total: profiles.length,
      active: activeProfiles.length,
      profiles: activeProfiles.map((p) => ({ id: p.id, title: p.title, queries: p.queries, locations: p.locations })),
      effectiveQuery,
      source: activeProfiles.length > 0 ? "search-profiles" : "portals.yml",
    },
    scoring:
      "Search/explore rows have no score. Tracker Score column is X.X/5 (N/100 from chat is converted on write). Fit drafts in chat are ChatGPT-only until written via add_application/update_job.",
    dashboardHint:
      "If /pipeline?tab=EVALUATED is empty but MCP writes succeed, the browser session tenant does not match this MCP key's tenantId — open /connect and /account and remint the key while signed into the same account.",
  };
}

/** @param {string[]} xs */
function dedupeCaseInsensitive(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/** MCP discovery timeout guard — plan cap still applies (SYSTEM.md results/source). */
const MCP_PER_SOURCE_MAX = 30;

async function exploreJobs(args: Json) {
  const query = String(args.query ?? "").trim();
  const exclude = String(args.exclude ?? "").trim();
  const location = String(args.location ?? "").trim();
  const sourcesRaw = Array.isArray(args.sources) ? args.sources.map((s) => String(s).toLowerCase()) : [];
  const sources = sourcesRaw.filter((s): s is AtsSource => (ATS_SOURCES as string[]).includes(s));
  const account = currentAccount();
  if (!can(account, CAP.SEARCH_JOBS)) {
    throw new Error(denialReason(account, CAP.SEARCH_JOBS));
  }
  const limits = planLimits(account);
  const cap = limits?.results ?? 40;
  const perSourceCap = isOperator(account) ? cap : Math.min(cap, MCP_PER_SOURCE_MAX);
  const asked = Number(args.limit);
  const limit =
    Number.isFinite(asked) && asked > 0
      ? Math.min(asked, perSourceCap, cap)
      : Math.min(perSourceCap, cap);

  // M2/BL-091: when profile_id is set, run that tenant search profile's isolated
  // query (its queries/locations) instead of the ad-hoc args. The profile id also
  // stamps every discovered offer so a later save_jobs tags the pipeline rows.
  //
  // REQ-EP-003: an explicit profile_id, or an explicit ad-hoc query/location,
  // always wins. Otherwise — no args at all — this must behave like web Explore's
  // own default (explore/page.tsx): run every enabled search profile as its own
  // isolated pass, not fall through to an unfiltered/portals.yml-shaped scan the
  // member never configured.
  const profileId = String(args.profile_id ?? "").trim();
  let profilePatch: { positive?: string[]; allow?: string[] } = {};
  let discoveryProfiles: { id: string; title: string; queries: string[]; locations: string[] }[] = [];
  let profilesUsed: string[] = [];
  if (profileId) {
    const profile = getProfile(tenantRoot(), profileId);
    if (!profile) throw new Error(`search profile not found: ${profileId}`);
    profilePatch = {
      positive: profile.queries.length ? profile.queries : undefined,
      allow: profile.locations.length ? profile.locations : undefined,
    };
    profilesUsed = [profile.title];
  } else if (!query && !location) {
    const enabled = listProfiles(tenantRoot()).filter((p) => p.enabled);
    if (enabled.length) {
      discoveryProfiles = enabled.map((p) => ({ id: p.id, title: p.title, queries: p.queries, locations: p.locations }));
      profilesUsed = enabled.map((p) => p.title);
    }
  }

  const filters = parseExplorePatch(
    {
      positive: profilePatch.positive ?? (query ? query.split(/[,;]/) : undefined),
      negative: exclude ? exclude.split(/[,;]/) : undefined,
      allow: profilePatch.allow ?? (location ? [location] : undefined),
      country: args.country,
      distanceKm: args.distance_km,
      sinceDays: args.since_days,
      ats: sources.length ? sources : ["linkedin", "drushim"],
      limitPerAts: limit,
    },
    { ...DEFAULT_FILTERS, ats: ["linkedin", "drushim"], limitPerAts: limit },
  );

  // Use the return value, not an onEvent side-channel: runDiscovery's multi-profile
  // path dedupes across profiles in that return value only (same URL from two
  // profiles keeps the first profile's tag) — an onEvent-accumulated array would
  // double-count a posting two enabled profiles both matched.
  const offers: DiscoveredOffer[] = await runDiscovery(
    filters,
    (e) => {
      if (profileId && e.kind === "offer") e.offer.profileId = profileId;
    },
    discoveryProfiles.length ? { profiles: discoveryProfiles } : undefined,
  );
  const matched = offers.length;
  const jobs = offers.slice(0, cap).map((o) =>
    formatMcpJobCard({
      kind: "discovered",
      company: o.company,
      title: o.title,
      location: o.location,
      source: o.source || o.ats,
      postedAt: o.postedAt || undefined,
      url: o.url,
      summary: o.summary,
      description: o.description,
    }),
  );
  rememberExploreJobs(jobs);
  return mcpJobListResponse(jobs, {
    query: filters.positive,
    country: filters.country || null,
    distanceKm: filters.distanceKm || null,
    sources: filters.ats,
    limitApplied: limit,
    profilesUsed: profilesUsed.length ? profilesUsed : undefined,
    truncated: matched > cap || (Number.isFinite(asked) && asked > limit),
    meta: {
      plan: account.plan ?? "alpha",
      role: account.role ?? "member",
      matched,
      shown: jobs.length,
      resultsLimit: cap,
      perSourceLimit: limit,
      truncated: matched > cap,
    },
  });
}

export async function callMcpTool(name: string, args: Json): Promise<ReturnType<typeof toolTextResult>> {
  try {
    switch (name) {
      case "whoami":
        return jsonText(await whoami());
      case "get_resume": {
        const content = readTenantFile("cv.md");
        return jsonText({ exists: Boolean(content.trim()), content });
      }
      case "update_resume": {
        const content = String(args.content ?? "");
        if (!content.trim()) return jsonText({ error: "content required" }, true);
        writeTenantFile("cv.md", content, MAX_CV, "CV");
        return jsonText({ ok: true, bytes: Buffer.byteLength(content, "utf8") });
      }
      case "resume_update": {
        const find = String(args.find ?? "");
        const replaceWith = String(args.replace_with ?? "");
        if (!find) return jsonText({ error: "find required" }, true);
        const current = readTenantFile("cv.md");
        if (!current.trim()) {
          return jsonText({ error: "no cv.md yet — save one first with resume_upload or update_resume" }, true);
        }
        if (!current.includes(find)) {
          return jsonText(
            { error: "`find` text not found in cv.md. Read get_resume and copy the exact text." },
            true,
          );
        }
        const updated = current.replace(find, () => replaceWith);
        writeTenantFile("cv.md", updated, MAX_CV, "CV");
        return jsonText({ ok: true, bytes: Buffer.byteLength(updated, "utf8") });
      }
      case "resume_upload": {
        const md = args.content;
        const pdfB64 = args.content_pdf_base64;
        if (typeof md !== "string" && typeof pdfB64 !== "string") {
          return jsonText({ error: "pass content (markdown) or content_pdf_base64" }, true);
        }
        if (md !== undefined && pdfB64 !== undefined) {
          return jsonText({ error: "pass exactly one of content / content_pdf_base64" }, true);
        }
        if (typeof md === "string") {
          if (!md.trim()) return jsonText({ error: "content is empty" }, true);
          writeTenantFile("cv.md", md, MAX_CV, "CV");
          return jsonText({
            ok: true,
            stored_as: "cv.md",
            bytes: Buffer.byteLength(md, "utf8"),
          });
        }
        let buf: Buffer;
        try {
          buf = Buffer.from(String(pdfB64), "base64");
        } catch {
          return jsonText({ error: "content_pdf_base64 is not valid base64" }, true);
        }
        if (!buf.length || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
          return jsonText({ error: "decoded bytes are not a PDF" }, true);
        }
        if (buf.length > MAX_RESUME_PDF) {
          return jsonText({ error: `PDF is larger than ${Math.floor(MAX_RESUME_PDF / 1024 / 1024)} MB` }, true);
        }
        const pdfPath = path.join(tenantRoot(), "uploads", "resume.pdf");
        fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
        fs.writeFileSync(pdfPath, buf, { mode: 0o600 });
        return jsonText({ ok: true, stored_as: "uploads/resume.pdf", bytes: buf.length });
      }
      case "resume_download_link": {
        const format = String(args.format ?? "pdf").toLowerCase();
        let rel: string | null = null;
        if (format === "md") {
          rel = readTenantFile("cv.md").trim() ? "cv.md" : null;
          if (!rel) return jsonText({ error: "no cv.md saved yet" }, true);
        } else if (format === "pdf") {
          rel = latestTenantPdf();
          if (!rel) {
            const hasUpload = fs.existsSync(path.join(tenantRoot(), "uploads", "resume.pdf"));
            if (hasUpload) {
              rel = "uploads/resume.pdf";
            } else {
              return jsonText(
                { error: "no PDF yet — call resume_generate first (or upload one with resume_upload)" },
                true,
              );
            }
          }
        } else {
          return jsonText({ error: "format must be 'md' or 'pdf'" }, true);
        }
        try {
          return jsonText({ ok: true, file: rel, ...signedLinkFor(rel), note: "link expires; ask again for a fresh one" });
        } catch (e) {
          return jsonText({ error: e instanceof Error ? e.message : "could not sign link" }, true);
        }
      }
      case "resume_generate": {
        // BL-066: gated by TOOL_CAPS in mcp/handler.ts before this dispatches
        // (must run before consumeMcpCall, not here).
        const maxPages = Number(args.max_pages) === 2 ? 2 : 1;
        const result = await generateCvPdf(maxPages as 1 | 2);
        if (!result.ok) return jsonText({ error: result.error }, true);
        // The worker may report the PDF from its own mount, so the reported
        // path does not always relativize under this process's tenantRoot.
        // cv-export writes into this tenant's output/ by contract — fall back
        // to signing that location by basename (QA round 3, #51).
        const relPdf = (() => {
          const root = tenantRoot();
          const resolved = path.resolve(result.pdf);
          if (resolved.startsWith(root + path.sep)) return path.relative(root, resolved);
          const base = path.basename(resolved);
          return fs.existsSync(path.join(root, "output", base)) ? `output/${base}` : null;
        })();
        const link = relPdf ? signedLinkFor(relPdf) : null;
        return jsonText({
          ok: true,
          pdf: result.pdf,
          pages: result.pages,
          trimmed_bullets: result.trimmed.length,
          download_web: `/api/cv/export?file=${encodeURIComponent(result.pdf)}`,
          ...(link ? { download_link: link.url, link_expires_at: link.expires_at } : {}),
        });
      }
      case "jobs_fetch":
        return await jobsFetch(args);
      case "submit_score":
        return submitScore(args);
      case "explore_jobs":
      case "job_table": {
        const payload = await exploreJobs(args);
        const extra = payload as typeof payload & {
          country?: string | null;
          sources?: string[];
          profilesUsed?: string[];
          meta?: Record<string, unknown>;
        };
        const bits = [
          extra.country ? String(extra.country) : "",
          Array.isArray(extra.sources) ? extra.sources.join("+") : "",
          Array.isArray(extra.profilesUsed) && extra.profilesUsed.length ? extra.profilesUsed.join(" + ") : "",
        ].filter(Boolean);
        const title = bits.length ? `Job search · ${bits.join(" · ")}` : "Job search";
        return jobListText(payload.jobs as Array<Record<string, unknown>>, title, {
          meta: extra.meta,
        });
      }
      case "save_jobs": {
        const jobs = Array.isArray(args.jobs) ? (args.jobs as DiscoveredOffer[]) : [];
        // M2: stamp every saved row with the profile that produced it so the
        // pipeline inbox can group/filter by profile. Caller passes profile_id;
        // a job carrying its own profileId wins (per-row override).
        const profileId = String(args.profile_id ?? "").trim();
        if (profileId) {
          for (const j of jobs) {
            if (j && !j.profileId) j.profileId = profileId;
          }
        }
        const result = await addOffersToPipeline(jobs);
        return jsonText(result, Boolean(result.error));
      }
      case "list_inbox": {
        const s = pipelineSummary();
        const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
        const query = String(args.query ?? "").trim().toLowerCase();
        const sourceArg = String(args.source ?? "").trim().toLowerCase();
        const location = String(args.location ?? "").trim().toLowerCase();

        let filtered = s.inbox;
        if (query) {
          filtered = filtered.filter((j) => `${j.company} ${j.role}`.toLowerCase().includes(query));
        }
        if (location) {
          filtered = filtered.filter((j) => (j.location ?? "").toLowerCase().includes(location));
        }
        if (sourceArg) {
          filtered = filtered.filter((j) => atsSourceFromUrl(j.url) === sourceArg);
        }
        const matched = filtered.length;
        const page = filtered.slice(0, limit);
        const jobs = page.map((j) =>
          formatMcpJobCard({
            kind: "inbox",
            company: j.company,
            title: j.role,
            role: j.role,
            location: j.location,
            postedAt: j.postedAt,
            url: j.url,
          }),
        );
        const titleBits = [
          query ? `q:${query}` : "",
          sourceArg ? `source:${sourceArg}` : "",
          location ? `location:${location}` : "",
        ].filter(Boolean);
        const title = titleBits.length ? `Pipeline inbox · ${titleBits.join(" · ")}` : "Pipeline inbox";
        return jobListText(jobs as Array<Record<string, unknown>>, title, {
          meta: { matched, shown: page.length },
        });
      }
      case "list_applications":
      case "search_applications": {
        const status = String(args.status ?? "").trim().toLowerCase();
        const query = String(args.query ?? "").trim();
        const company = String(args.company ?? "").trim();
        const limit = Math.min(Math.max(Number(args.limit) || 80, 1), 200);
        const offset = Math.max(Number(args.offset) || 0, 0);
        const from = String(args.from ?? "").trim();
        const to = String(args.to ?? "").trim();
        const includeNotes = Boolean(args.include_notes);
        const found = searchApplications({ status, query, company, limit, offset, from, to });
        const counts = trackerStatusCounts();
        const jobs = found.rows.map((a) =>
          formatMcpJobCard({
            kind: "application",
            company: a.company,
            title: a.role,
            role: a.role,
            url: urlFromNotes(a.notes),
            n: a.n,
            status: a.status,
            score: a.score,
            notes: a.notes,
          }),
        );
        const titleBits = [
          status ? status : "",
          company ? `company:${company}` : "",
          query ? `q:${query}` : "",
          from ? `from:${from}` : "",
          to ? `to:${to}` : "",
        ].filter(Boolean);
        const title = titleBits.length ? `Tracker · ${titleBits.join(" · ")}` : "Tracker";
        return jobListText(jobs as Array<Record<string, unknown>>, title, {
          tracker: true,
          includeNotes,
          meta: {
            tenantId: tenantId(),
            matched: found.matched,
            shown: found.shown,
            offset: found.offset,
            total: counts.total,
            byStatus: counts.byStatus,
            plan: currentAccount().plan ?? "alpha",
          },
        });
      }
      case "get_followups": {
        const overdueOnly = Boolean(args.overdue_only);
        const script = rootScript("followup-cadence");
        if (!fs.existsSync(script)) {
          return jsonText({ error: "followup-cadence.mjs not available on this install", _format: { version: 1 } }, true);
        }
        const { stdout } = await runNodeScript(script, overdueOnly ? ["--overdue-only"] : [], {
          cwd: tenantRoot(),
          timeoutMs: 12_000,
          env: tenantScriptEnv(),
        });
        let parsed: { metadata?: Record<string, unknown>; entries?: Array<Record<string, unknown>>; error?: string };
        try {
          const start = stdout.indexOf("{");
          parsed = JSON.parse(stdout.slice(start));
        } catch {
          return jsonText({ error: "could not read follow-up cadence output", _format: { version: 1 } }, true);
        }
        if (parsed.error) {
          return toolTextResult(`_${parsed.error}_`);
        }
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        const rows = entries.map((e) => {
          const followups = Array.isArray(e.followups) ? (e.followups as Array<{ date?: string }>) : [];
          const lastContact = followups.length ? followups[0]?.date : e.appliedDate;
          const daysUntilNext = typeof e.daysUntilNext === "number" ? e.daysUntilNext : null;
          const daysOverdue =
            (e.urgency === "overdue" || e.urgency === "urgent") && daysUntilNext != null && daysUntilNext < 0
              ? String(-daysUntilNext)
              : "—";
          return `| ${mdCell(e.company)} | ${mdCell(e.role)} | ${mdCell(e.status)} | ${mdCell(lastContact)} | ${mdCell(e.nextFollowupDate)} | ${mdCell(daysOverdue)} |`;
        });
        const head = "| Company | Role | Status | Last contact | Due date | Days overdue |";
        const sep = "| --- | --- | --- | --- | --- | --- |";
        const meta = parsed.metadata ?? {};
        const title = overdueOnly ? "Follow-ups · overdue" : "Follow-ups";
        const lines = [
          `## ${title} (${rows.length})`,
          "",
          rows.length ? [head, sep, ...rows].join("\n") : "_No rows need a follow-up right now._",
          "",
          `_tenant: ${tenantId()} · overdue: ${meta.overdue ?? 0} · urgent: ${meta.urgent ?? 0} · waiting: ${meta.waiting ?? 0} · cold: ${meta.cold ?? 0}_`,
        ];
        return toolTextResult(lines.join("\n"));
      }
      case "company_history": {
        const company = String(args.company ?? "").trim();
        if (!company) return jsonText({ error: "company is required", _format: { version: 1 } }, true);

        const found = searchApplications({ company, limit: 200 });
        const rows = found.rows.map((a) => {
          return `| ${mdCell(a.role)} | ${mdCell(a.status)} | ${mdCell(a.score)} | ${mdCell(a.date)} | ${mdCell(a.notes)} |`;
        });
        const head = "| Role | Status | Score | Date | Notes |";
        const sep = "| --- | --- | --- | --- | --- |";

        let cardLines: string[] = [];
        const script = rootScript("company-history");
        if (fs.existsSync(script)) {
          try {
            const { stdout } = await runNodeScript(script, ["--company", company], {
              cwd: tenantRoot(),
              timeoutMs: 12_000,
              env: tenantScriptEnv(),
            });
            const start = stdout.indexOf("{");
            const card = JSON.parse(stdout.slice(start)) as {
              responsiveness?: { label?: string; facts?: Array<Record<string, unknown>> };
              postingChurn?: { label?: string; clusters?: unknown[] };
            };
            const respLabel = card.responsiveness?.label ?? "no-history";
            const respFacts = card.responsiveness?.facts?.length ?? 0;
            const churnLabel = card.postingChurn?.label ?? "no-scan-data";
            cardLines = [
              "",
              `_Responsiveness: ${respLabel}${respFacts ? ` (${respFacts} fact${respFacts === 1 ? "" : "s"})` : ""} · Posting churn: ${churnLabel}_`,
            ];
          } catch {
            // Evidence card is supplementary — a parse/spawn failure here must
            // not hide the tracker rows, which are the row-level requirement.
          }
        }

        if (!rows.length) {
          return toolTextResult(`_No tracker rows found for "${company}"._${cardLines.join("\n")}`);
        }
        const lines = [`## ${mdCell(company)} (${rows.length})`, "", [head, sep, ...rows].join("\n"), ...cardLines];
        return toolTextResult(lines.join("\n"));
      }
      case "check_liveness": {
        const url = String(args.url ?? "").trim();
        if (!url) return jsonText({ state: "unknown", reason: "url is required" }, true);
        try {
          const api = await checkLivenessViaApi(url);
          if (api) {
            const state = api.result === "active" ? "open" : api.result === "expired" ? "closed" : "unknown";
            return jsonText({ state, reason: api.reason });
          }
          const reason = isAtsPosting(url)
            ? "ATS API check was inconclusive (rate-limited, 5xx, or redirected)"
            : "not a recognized ATS posting URL — this deployment has no page renderer available for read-tool calls";
          return jsonText({ state: "unknown", reason });
        } catch (err) {
          return jsonText({ state: "unknown", reason: `check failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
      case "get_report": {
        const n = String(args.n ?? "").trim();
        if (!n) return jsonText({ error: "n is required" }, true);
        const report = readReport(n);
        if (!report) return jsonText({ error: `report ${n} not found` }, true);
        return jsonText({ n, file: report.file, content: report.content });
      }
      case "pipeline_stats":
        return jsonText(trackerStatusCounts());
      case "add_application":
        return jsonText({ ...(await addManualApplication(args)), tenantId: tenantId() });
      case "update_application": {
        const ns = Array.isArray(args.ns)
          ? args.ns.map((x) => String(x))
          : args.n
            ? [String(args.n)]
            : [];
        return jsonText({ ...updateApplicationStatus(ns, String(args.status ?? "")), tenantId: tenantId() });
      }
      case "update_job":
        return jsonText({
          ...updateJobPosting({
            n: args.n != null ? String(args.n) : undefined,
            url: args.url != null ? String(args.url) : undefined,
            company: args.company != null ? String(args.company) : undefined,
            role: args.role != null ? String(args.role) : undefined,
            status: args.status != null ? String(args.status) : undefined,
            score: args.score != null ? String(args.score) : undefined,
            notes: args.notes != null ? String(args.notes) : undefined,
            appendNotes: Boolean(args.append_notes),
          }),
          tenantId: tenantId(),
        });
      case "remove_application":
        return jsonText(await deleteApplication(String(args.n ?? "").trim()));
      case "get_job": {
        const s = pipelineSummary();
        const n = String(args.n ?? "").trim();
        const url = String(args.url ?? "").trim();
        const urlByN = new Map(s.reportUrls.map((r) => [String(r.n), r.url]));
        if (n) {
          const row = s.applications.find((a) => a.n === n || String(parseInt(a.n, 10)) === String(parseInt(n, 10)));
          if (!row) return jsonText({ error: "not found", _format: { version: 1 } }, true);
          const job = formatMcpJobCard({
            kind: "application",
            company: row.company,
            title: row.role,
            role: row.role,
            url: urlByN.get(String(row.n)) ?? null,
            n: row.n,
            status: row.status,
            score: row.score,
            notes: row.notes,
          });
          return toolTextResult(renderJobDetailBlock(job, "Tracker row", { tracker: true }));
        }
        if (url) {
          const inbox = s.inbox.find((j) => j.url === url);
          if (inbox) {
            const cached = recentJobByKey.get(recentJobKey(url));
            const job = formatMcpJobCard({
              kind: "inbox",
              company: inbox.company,
              title: inbox.role,
              role: inbox.role,
              location: inbox.location,
              postedAt: inbox.postedAt,
              url: inbox.url,
              summary: cached?.summary,
              description: cached?.description,
            });
            return toolTextResult(renderJobDetailBlock(job, "Pipeline inbox"));
          }
          const app = s.applications.find((a) => a.notes.includes(url));
          if (app) {
            const cached = recentJobByKey.get(recentJobKey(url));
            const job = formatMcpJobCard({
              kind: "application",
              company: app.company,
              title: app.role,
              role: app.role,
              url,
              n: app.n,
              status: app.status,
              score: app.score,
              notes: app.notes,
              summary: cached?.summary,
              description: cached?.description,
            });
            return toolTextResult(renderJobDetailBlock(job, "Tracker row", { tracker: true }));
          }
          const cached = recentJobByKey.get(recentJobKey(url));
          if (cached) {
            const job = formatMcpJobCard({
              kind: "discovered",
              company: cached.company,
              title: cached.title,
              location: cached.location,
              postedAt: cached.postedAt,
              source: cached.source,
              url,
              summary: cached.summary,
              description: cached.description,
            });
            return toolTextResult(renderJobDetailBlock(job, "Recent search"));
          }
          return jsonText({ error: "not found", _format: { version: 1 } }, true);
        }
        return jsonText({ error: "url or n required", _format: { version: 1 } }, true);
      }
      case "get_rules": {
        const content = readTenantFile("modes/_custom.md");
        return jsonText({
          content,
          mcpOutputContract: MCP_OUTPUT_CONTRACT,
          hasMcpOutputSection: hasMcpOutputSection(content),
          hint: hasMcpOutputSection(content)
            ? "Contract is in modes/_custom.md."
            : "Copy mcpOutputContract into modes/_custom.md via update_rules for persistence across chats.",
        });
      }
      case "update_rules": {
        const content = String(args.content ?? "");
        writeTenantFile("modes/_custom.md", content, MAX_RULES, "rules file");
        return jsonText({ ok: true });
      }
      case "export_snapshot":
        return jsonText({
          cv: readTenantFile("cv.md"),
          rules: readTenantFile("modes/_custom.md"),
          tracker: readTenantFile("data/applications.md"),
          pipeline: readTenantFile("data/pipeline.md"),
        });
      default:
        return jsonText({ error: `unknown tool: ${name}` }, true);
    }
  } catch (e) {
    return toolTextResult(e instanceof Error ? e.message : "tool failed", true);
  }
}
