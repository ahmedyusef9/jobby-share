/**
 * Canonical MCP job shape — one formatter for explore, inbox, tracker, get_job.
 * ChatGPT/Claude must render links.posting + links.jobby; both are absolute URLs.
 */
import { MCP_OUTPUT_CONTRACT_SHORT } from './mcp-output-contract.mjs';

export const MCP_JOB_FORMAT_VERSION = 1;

/** Mirror of web/src/lib/role-href.ts — keep in sync. */
function rolePageHref(opts) {
  const n = opts.n ? String(parseInt(String(opts.n), 10)) : '';
  if (n && !Number.isNaN(Number(n))) return `/pipeline/${n}`;
  const sp = new URLSearchParams();
  if (opts.url) sp.set('url', opts.url);
  if (opts.company) sp.set('company', opts.company);
  if (opts.role) sp.set('role', opts.role);
  const qs = sp.toString();
  return qs ? `/pipeline/open?${qs}` : '/pipeline';
}

export const MCP_JOB_LIST_META = {
  version: MCP_JOB_FORMAT_VERSION,
  tableColumns: ['Company', 'Role', 'Location', 'Posted', 'Posting', 'Jobby'],
  renderHint:
    'Paste the tool table unchanged. Briefs below give product/role context for fit. Fit analysis below the table as X.X/5 — label assistant scores. ' +
    MCP_OUTPUT_CONTRACT_SHORT,
};

function isLocalhostOrigin(origin) {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local');
  } catch {
    return true;
  }
}

/** @returns {string} origin for dashboard deep links — prefer public HTTPS over localhost. */
export function mcpDashboardOrigin() {
  const app = String(process.env.JOBBY_APP_PUBLIC_URL || '')
    .trim()
    .replace(/\/$/, '');
  const mcp = String(process.env.JOBBY_MCP_PUBLIC_URL || '')
    .trim()
    .replace(/\/$/, '');
  const auth = String(process.env.AUTH_URL || '')
    .trim()
    .replace(/\/$/, '');
  const ordered = [app, mcp, ...(auth && !isLocalhostOrigin(auth) ? [auth] : []), auth].filter(Boolean);
  for (const o of ordered) {
    try {
      const u = new URL(o);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch {
      /* skip */
    }
  }
  return 'http://localhost:3000';
}

/**
 * @param {string} path
 * @returns {string}
 */
export function mcpAbsoluteDashboardUrl(path) {
  const rel = path.startsWith('/') ? path : `/${path}`;
  return `${mcpDashboardOrigin()}${rel}`;
}

/**
 * @param {{
 *   company?: string;
 *   title?: string;
 *   role?: string;
 *   location?: string;
 *   source?: string;
 *   postedAt?: string;
 *   url?: string | null;
 *   n?: string | null;
 *   status?: string | null;
 *   score?: string | null;
 *   notes?: string | null;
 *   summary?: string | null;
 *   description?: string | null;
 *   kind?: 'discovered' | 'inbox' | 'application';
 * }} input
 */
export function formatMcpJobCard(input) {
  const company = String(input.company ?? '').trim() || '—';
  const title = String(input.title ?? input.role ?? '').trim() || '—';
  const role = String(input.role ?? input.title ?? '').trim() || title;
  const posting = String(input.url ?? '').trim();
  const n = input.n ? String(parseInt(String(input.n), 10)) : '';
  const path = rolePageHref({
    n: n && !Number.isNaN(Number(n)) ? n : null,
    url: posting || null,
    company,
    role,
  });
  const summary = String(input.summary ?? '').replace(/\s+/g, ' ').trim();
  const description = String(input.description ?? '').replace(/\s+/g, ' ').trim();

  return {
    company,
    title,
    location: String(input.location ?? '').trim() || null,
    source: String(input.source ?? '').trim() || null,
    postedAt: String(input.postedAt ?? '').trim() || null,
    links: {
      posting: posting || null,
      jobby: mcpAbsoluteDashboardUrl(path),
    },
    ...(input.kind ? { kind: input.kind } : {}),
    ...(n ? { trackerN: n } : {}),
    ...(input.status != null && String(input.status).trim() ? { status: String(input.status).trim() } : {}),
    ...(input.score != null && String(input.score).trim() ? { score: String(input.score).trim() } : {}),
    ...(input.notes != null && String(input.notes).trim() ? { notes: String(input.notes).trim() } : {}),
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
  };
}

/** @param {string | null | undefined} s */
function mdCell(s) {
  return String(s ?? '—')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}

/** @param {string} label @param {string | null | undefined} url */
function mdLink(label, url) {
  const href = String(url ?? '').trim();
  return href ? `[${label}](${href})` : '—';
}

/** @param {string | null | undefined} postedAt */
function formatPostedCell(postedAt) {
  const s = String(postedAt ?? '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '—';
}

/**
 * Single markdown table block — the entire MCP tool body for job lists.
 * @param {Array<{ company?: string; title?: string; location?: string | null; source?: string | null; postedAt?: string | null; status?: string; score?: string; links?: { posting?: string | null; jobby?: string } }>} jobs
 * @param {{ tracker?: boolean }} [opts]
 */
export function renderJobsTableMarkdown(jobs, { tracker = false, includeNotes = false } = {}) {
  const notesCol = tracker && includeNotes;
  const head = tracker
    ? `| Company | Role | Location | Posted | Status | Score | Posting | Jobby |${notesCol ? ' Notes |' : ''}`
    : '| Company | Role | Location | Posted | Posting | Jobby |';
  const sep = tracker
    ? `| --- | --- | --- | --- | --- | --- | --- | --- |${notesCol ? ' --- |' : ''}`
    : '| --- | --- | --- | --- | --- | --- |';
  const rows = jobs.map((j) => {
    if (tracker) {
      return `| ${mdCell(j.company)} | ${mdCell(j.title)} | ${mdCell(j.location)} | ${formatPostedCell(j.postedAt)} | ${mdCell(j.status)} | ${mdCell(j.score)} | ${mdLink('Posting', j.links?.posting)} | ${mdLink('Jobby', j.links?.jobby)} |${notesCol ? ` ${mdCell(j.notes)} |` : ''}`;
    }
    return `| ${mdCell(j.company)} | ${mdCell(j.title)} | ${mdCell(j.location)} | ${formatPostedCell(j.postedAt)} | ${mdLink('Posting', j.links?.posting)} | ${mdLink('Jobby', j.links?.jobby)} |`;
  });
  return [head, sep, ...rows].join('\n');
}

/** @param {Record<string, unknown>} meta */
function formatTableMetaFooter(meta) {
  const parts = [];
  if (meta.tenantId) parts.push(`tenant: ${meta.tenantId}`);
  if (meta.plan) parts.push(`plan: ${meta.plan}`);
  const offsetSuffix = meta.offset ? ` (offset ${meta.offset})` : '';
  if (meta.shown != null && meta.matched != null) {
    parts.push(`showing ${meta.shown} of ${meta.matched} matches${offsetSuffix}`);
  } else if (meta.shown != null && meta.total != null) {
    parts.push(`showing ${meta.shown} of ${meta.total} tracker rows${offsetSuffix}`);
  }
  if (meta.resultsLimit != null) parts.push(`plan cap ${meta.resultsLimit}`);
  if (meta.perSourceLimit != null) parts.push(`${meta.perSourceLimit}/source`);
  if (meta.truncated) parts.push('truncated to plan cap');
  if (meta.byStatus && typeof meta.byStatus === 'object') {
    const bits = Object.entries(meta.byStatus)
      .map(([k, v]) => `${k}:${v}`)
      .slice(0, 8);
    if (bits.length) parts.push(`counts ${bits.join(' ')}`);
  }
  parts.push(
    'Score: search rows have no Jobby score — tracker uses X.X/5; fit notes below table are ChatGPT drafts until written via add_application/update_job',
  );
  return parts.join(' · ');
}

/**
 * Short product/role blurbs under the lean table — omit jobs with no summary.
 * @param {Array<{ company?: string; title?: string; summary?: string | null }>} jobs
 */
export function renderJobsBriefsMarkdown(jobs) {
  const blocks = [];
  for (const j of jobs) {
    const summary = String(j.summary ?? '').trim();
    if (!summary) continue;
    const company = String(j.company ?? '—').trim() || '—';
    const title = String(j.title ?? '—').trim() || '—';
    blocks.push(`### ${company} — ${title}`, '', summary);
  }
  if (!blocks.length) return '';
  return ['## Briefs', '', ...blocks].join('\n');
}

/**
 * Full tool text: lean table + optional Briefs for AI fit context.
 * @param {Parameters<typeof renderJobsTableMarkdown>[0]} jobs
 * @param {string} title
 * @param {{ tracker?: boolean; meta?: Record<string, unknown>; includeBriefs?: boolean }} [opts]
 */
export function renderJobsTableBlock(jobs, title, opts = {}) {
  const n = jobs.length;
  const table = renderJobsTableMarkdown(jobs, opts);
  const includeBriefs = opts.includeBriefs !== false && !opts.tracker;
  const lines = [
    `## ${title} (${n})`,
    '',
    table,
  ];
  // jobs_fetch (BL-056) opts out: its contract is the bare verbatim table —
  // the assistant-facing instruction line is prose, not data.
  if (opts.includeContractNote !== false) {
    lines.push(
      '',
      '_Show this table unchanged in your reply — every row includes Posted, Posting, and Jobby links. Use Briefs (when present) for product/role fit; add fit commentary below as X.X/5 in the same row order (label assistant scores). No replacement table._',
    );
  }
  if (opts.meta) {
    lines.push('', `_${formatTableMetaFooter(opts.meta)}_`);
  }
  if (includeBriefs) {
    const briefs = renderJobsBriefsMarkdown(jobs);
    if (briefs) {
      lines.push('', briefs);
    }
  }
  return lines.join('\n');
}

/**
 * One job for get_job: table row + full description when available.
 * @param {Parameters<typeof formatMcpJobCard>[0] | ReturnType<typeof formatMcpJobCard>} job
 * @param {string} title
 * @param {{ tracker?: boolean }} [opts]
 */
export function renderJobDetailBlock(job, title, opts = {}) {
  const card = job.links ? job : formatMcpJobCard(job);
  const lines = [
    renderJobsTableBlock([card], title, { ...opts, includeBriefs: false }),
  ];
  const description = String(card.description ?? '').trim();
  if (description) {
    lines.push('', '## Description', '', description);
  } else {
    lines.push('', '_No posting description was captured for this row._');
  }
  return lines.join('\n');
}

/**
 * @param {unknown[]} jobs
 * @param {Record<string, unknown>} [extra]
 */
export function mcpJobListResponse(jobs, extra = {}) {
  const tracker = Boolean(extra.statusFilter) || jobs.some((j) => j?.status || j?.score);
  const tableMarkdown = renderJobsTableMarkdown(jobs, { tracker });
  return {
    _format: MCP_JOB_LIST_META,
    count: jobs.length,
    tableMarkdown,
    jobs,
    ...extra,
  };
}
