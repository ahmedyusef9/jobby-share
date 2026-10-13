/**
 * Explore board sources that are not reverse-ATS directories.
 *
 * Greenhouse / Lever / Ashby / Workday stay on scan-ats-full.mjs.
 * Drushim and LinkedIn already have parsers under scripts/parsers/; Explore
 * just had no way to turn those chips on. This module is the seam.
 *
 * LinkedIn is JobSpy (scripts/parsers/jobspy-jobs.mjs), not a new scraper.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { platformRoot } from './resolve-root.mjs';

export const ATS_DIRECTORIES = Object.freeze(['greenhouse', 'lever', 'ashby', 'workday']);
export const BOARD_SOURCES = Object.freeze(['drushim', 'linkedin']);
export const EXPLORE_SOURCES = Object.freeze([...ATS_DIRECTORIES, ...BOARD_SOURCES]);

export const EXPLORE_SOURCE_LABEL = Object.freeze({
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  drushim: 'Drushim',
  linkedin: 'LinkedIn',
});

const MAX_TERMS = 4;
const DRUSHIM_PAGES = 3;
const JOBSPY_RESULTS = 20;
const DESCRIPTION_MAX = 4000;
const SUMMARY_MAX = 280;

/** JobSpy Indeed/Glassdoor country_indeed values. Unknown strings pass through. */
const COUNTRY_INDEED = Object.freeze({
  israel: 'Israel',
  il: 'Israel',
  usa: 'USA',
  us: 'USA',
  'united states': 'USA',
  uk: 'UK',
  gb: 'UK',
  'united kingdom': 'UK',
  germany: 'Germany',
  de: 'Germany',
  netherlands: 'Netherlands',
  nl: 'Netherlands',
  france: 'France',
  fr: 'France',
  spain: 'Spain',
  es: 'Spain',
  canada: 'Canada',
  ca: 'Canada',
  remote: '',
  europe: '',
});

/**
 * @param {string} country
 */
export function jobspyCountry(country) {
  const raw = String(country || '').trim();
  if (!raw) return '';
  const mapped = COUNTRY_INDEED[raw.toLowerCase()];
  if (mapped === '') return '';
  return mapped || raw;
}

/**
 * JobSpy `distance` is miles. Explore speaks kilometres.
 * @param {number} km
 */
export function kmToMiles(km) {
  const n = Number(km);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round(n * 0.621371));
}

/** @param {string} id */
export function isAtsDirectory(id) {
  return ATS_DIRECTORIES.includes(id);
}

/** @param {string} id */
export function isBoardSource(id) {
  return BOARD_SOURCES.includes(id);
}

/**
 * Keyword boards need a search term. ATS-full treats empty positive as "every
 * title"; Drushim/JobSpy would error. Cap the list so one Explore run cannot
 * fan out into dozens of HTTP pages.
 *
 * @param {string[]} positive
 * @param {number} [max]
 */
export function pickSearchTerms(positive, max = MAX_TERMS) {
  const seen = new Set();
  const out = [];
  for (const raw of positive || []) {
    const t = String(raw || '').trim();
    if (t.length < 2) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out.length ? out : ['software'];
}

/**
 * @param {string[]} places
 */
export function wantsIsrael(places) {
  return (places || []).some((p) =>
    /israel|tel[\s-]?aviv|\btlv\b|ירושל|חיפה|רמת גן|פתח תקווה/i.test(String(p || '')),
  );
}

/**
 * Drushim is an Israel board. If the user narrowed "Only in" to somewhere else,
 * running it would only add noise (then get dropped). Empty allow = still run it.
 *
 * @param {{ allow?: string[], alwaysAllow?: string[] }} filters
 */
export function shouldRunDrushim(filters) {
  const allow = filters?.allow || [];
  if (allow.length === 0) return true;
  return wantsIsrael([...allow, ...(filters?.alwaysAllow || [])]);
}

/**
 * @param {{ allow?: string[], alwaysAllow?: string[] }} filters
 */
export function boardLocation(filters) {
  const places = [...(filters?.allow || []), ...(filters?.alwaysAllow || [])];
  return places.find((p) => String(p).trim()) || '';
}

/**
 * @param {string} title
 * @param {string[]} positive
 * @param {string[]} negative
 */
export function titlePasses(title, positive, negative) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  for (const n of negative || []) {
    if (n && t.includes(String(n).toLowerCase())) return false;
  }
  if (!positive?.length) return true;
  return positive.some((p) => p && t.includes(String(p).toLowerCase()));
}

/**
 * @param {string} scriptRel  path under the platform root
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<unknown>}
 */
function spawnJson(scriptRel, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const root = platformRoot();
  const script = path.resolve(root, scriptRel);
  if (!fs.existsSync(script)) {
    return Promise.reject(new Error(`${scriptRel} is not in this checkout`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout?.on('data', (c) => {
      out += c.toString();
    });
    child.stderr?.on('data', (c) => {
      err += c.toString();
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        reject(new Error((err.trim() || out.trim() || `${scriptRel} exited ${code}`).slice(0, 400)));
        return;
      }
      try {
        resolve(JSON.parse(out.trim() || '[]'));
      } catch {
        reject(new Error(`${scriptRel} did not print JSON`));
      }
    });
  });
}

/**
 * Normalize a posting date to YYYY-MM-DD for tables and scan history.
 * @param {unknown} value
 */
export function normalizePostedDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/**
 * Clean + cap a full job description for offers / get_job.
 * @param {unknown} value
 */
export function normalizeDescription(value) {
  let text = String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length > DESCRIPTION_MAX) {
    text = `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * Short blurb for MCP Briefs (≤280 chars). Does not invent content.
 * @param {unknown} description
 * @param {unknown} [summary]
 */
export function summarizeDescription(description, summary) {
  const preferred = String(summary ?? '').replace(/\s+/g, ' ').trim();
  const base = preferred || normalizeDescription(description);
  if (!base) return '';
  if (base.length <= SUMMARY_MAX) return base;
  const cut = base.slice(0, SUMMARY_MAX - 1);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
  const soft = at > SUMMARY_MAX * 0.45 ? cut.slice(0, at + 1).trim() : cut.trim();
  return `${soft}…`;
}

/**
 * @param {string} source
 * @param {{ title?: string, url?: string, company?: string, location?: string, postedAt?: string, description?: string, summary?: string }[]} jobs
 * @param {{ positive: string[], negative: string[] }} filters
 * @param {(offer: object) => void} onOffer
 */
function emitJobs(source, jobs, filters, onOffer) {
  let kept = 0;
  for (const job of jobs) {
    const url = String(job?.url || '').trim();
    const title = String(job?.title || '').trim();
    const company = String(job?.company || '').trim();
    if (!url || !title || !company) continue;
    if (!titlePasses(title, filters.positive, filters.negative)) continue;
    const description = normalizeDescription(job.description);
    const summary = summarizeDescription(description, job.summary);
    onOffer({
      url,
      title,
      company,
      location: String(job.location || '').trim(),
      postedAt: normalizePostedDate(job.postedAt),
      ats: source,
      source,
      ...(description ? { description } : {}),
      ...(summary ? { summary } : {}),
    });
    kept += 1;
  }
  return kept;
}

/**
 * @param {'drushim' | 'linkedin'} source
 * @param {{
 *   positive: string[],
 *   negative: string[],
 *   allow?: string[],
 *   alwaysAllow?: string[],
 *   sinceDays?: number,
 *   country?: string,
 *   distanceKm?: number,
 * }} filters
 * @param {{
 *   onEvent: (e: any) => void,
 *   onOffer: (offer: any) => void,
 * }} hooks
 */
export async function runBoardSource(source, filters, hooks) {
  const { onEvent, onOffer } = hooks;
  const terms = pickSearchTerms(filters.positive);
  const loc = boardLocation(filters) || jobspyCountry(filters.country);
  const country = jobspyCountry(filters.country);
  const miles = kmToMiles(filters.distanceKm);

  if (source === 'drushim' && !shouldRunDrushim(filters)) {
    onEvent({ kind: 'atsStart', ats: 'drushim', companies: 0 });
    onEvent({ kind: 'log', line: 'Drushim skipped — location filter is not Israel.' });
    onEvent({ kind: 'atsDone', ats: 'drushim', unreachable: 0 });
    return 0;
  }

  onEvent({ kind: 'atsStart', ats: source, companies: terms.length });
  onEvent({
    kind: 'progress',
    ats: source,
    scanned: 0,
    total: terms.length,
    matches: 0,
  });

  try {
    let raw;
    if (source === 'drushim') {
      const args = [];
      for (const t of terms) args.push('--term', t);
      args.push('--pages', String(DRUSHIM_PAGES));
      raw = await spawnJson(path.join('scripts', 'parsers', 'drushim-jobs.mjs'), args, {
        timeoutMs: 90_000,
      });
    } else {
      const args = ['--site', 'linkedin'];
      for (const t of terms) args.push('--term', t);
      args.push('--results', String(JOBSPY_RESULTS));
      args.push('--hours', String(Math.max(24, (filters.sinceDays || 7) * 24)));
      if (loc) args.push('--location', loc);
      if (country) args.push('--country', country);
      if (miles > 0) args.push('--distance', String(miles));
      if (wantsIsrael([loc, country]) || shouldRunDrushim(filters)) {
        args.push('--location-suffix', 'Israel');
      }
      raw = await spawnJson(path.join('scripts', 'parsers', 'jobspy-jobs.mjs'), args, {
        timeoutMs: 180_000,
      });
    }
    const jobs = Array.isArray(raw) ? raw : [];
    const kept = emitJobs(source, jobs, filters, onOffer);
    onEvent({
      kind: 'progress',
      ats: source,
      scanned: terms.length,
      total: terms.length,
      matches: kept,
    });
    onEvent({ kind: 'atsDone', ats: source, unreachable: 0 });
    return kept;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onEvent({ kind: 'log', line: `${EXPLORE_SOURCE_LABEL[source] || source}: ${msg}` });
    onEvent({ kind: 'atsDone', ats: source, unreachable: 1 });
    return 0;
  }
}
