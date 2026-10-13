#!/usr/bin/env node
// Drushim.co.il job scanner, emitted as jobs-json-v1 for scan.mjs's local_parser
// provider. Drushim is the largest Israeli job board and has no upstream provider.
//
// Lives in scripts/ rather than providers/ deliberately: providers/ is in
// update-system.mjs's SYSTEM_PATHS and is replaced wholesale on every update,
// scripts/ is in no path list and survives.
//
// Usage: node scripts/parsers/drushim-jobs.mjs --term python --term golang [--pages 5]

const API = 'https://www.drushim.co.il/api/jobs/search/';
const DEFAULT_PAGES = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const DESCRIPTION_MAX = 4000;

/** @param {unknown} html */
function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {unknown} description @param {unknown} requirements */
function buildDescription(description, requirements) {
  const parts = [stripHtml(description), stripHtml(requirements)].filter(Boolean);
  if (!parts.length) return '';
  let text = parts.join('\n\n');
  if (text.length > DESCRIPTION_MAX) {
    text = `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
  }
  return text;
}

function parseArgs(argv) {
  const terms = [];
  let pages = DEFAULT_PAGES;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--term') {
      const value = argv[i += 1];
      if (!value) throw new Error('--term requires a value');
      terms.push(value);
    } else if (arg === '--pages') {
      const value = Number(argv[i += 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--pages must be a positive integer, got: ${argv[i]}`);
      }
      pages = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (terms.length === 0) throw new Error('at least one --term is required');
  return { terms, pages };
}

async function fetchPage(term, page) {
  const url = `${API}?searchterm=${encodeURIComponent(term)}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      // Drushim returns HTML to clients that do not ask for JSON.
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; career-ops scanner)',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`drushim search failed (term="${term}", page=${page}): HTTP ${res.status}`);
  }

  return res.json();
}

// Drushim is Israel-only, but the scanner's location filter matches on English
// text. Emit the English city plus an explicit "Israel" so always_allow fires;
// without it every posting reads as an unknown location and gets dropped.
function buildLocation(jobContent) {
  // CityEnglish arrives padded with tabs ("\tLod\t"), which leaks into the
  // tracker and breaks TSV columns downstream.
  const cities = (jobContent.Addresses || [])
    .map(address => String(address.CityEnglish || address.City || '').trim())
    .filter(Boolean);

  const unique = [...new Set(cities)];
  return unique.length > 0 ? `${unique.join(', ')}, Israel` : 'Israel';
}

function postedDate(jobInfo) {
  const raw = jobInfo?.Date || jobInfo?.DisplayDate || jobInfo?.JumpDate;
  if (!raw) return '';
  const m = String(raw).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function toJob(entry) {
  const link = entry.JobInfo?.Link;
  const title = entry.JobContent?.Name || entry.JobContent?.FullName;
  if (!link || !title) return null;
  if (entry.JobInfo?.IsExpired) return null;

  const content = entry.JobContent || {};
  const description = buildDescription(content.Description, content.Requirements);
  return {
    title: String(title).trim(),
    url: new URL(link, 'https://www.drushim.co.il').href,
    company: (entry.Company?.CompanyDisplayName || entry.Company?.NameInHebrew || '').trim(),
    location: buildLocation(content),
    postedAt: postedDate(entry.JobInfo),
    ...(description ? { description } : {}),
  };
}

async function collect(terms, pages) {
  const byUrl = new Map();

  for (const term of terms) {
    for (let page = 1; page <= pages; page += 1) {
      const payload = await fetchPage(term, page);
      const results = payload.ResultList || [];
      if (results.length === 0) break;

      for (const entry of results) {
        const job = toJob(entry);
        if (job) byUrl.set(job.url, job);
      }

      const totalPages = Number(payload.TotalPagesNumber) || 0;
      if (page >= totalPages) break;
    }
  }

  return [...byUrl.values()];
}

async function main() {
  const { terms, pages } = parseArgs(process.argv.slice(2));
  const jobs = await collect(terms, pages);
  process.stdout.write(JSON.stringify(jobs));
}

main().catch(err => {
  console.error(`drushim-jobs: ${err.message}`);
  process.exit(1);
});
