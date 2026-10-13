/**
 * Trusted artifact checks for Score / PDF / research (D-021).
 *
 * A CLI printing VERDICT is not completion. The dispatcher looks at the
 * tenant directory after the process exits and records incomplete when the
 * canonical files are missing.
 *
 * Never returns report bodies, URLs, or CV text — only a class the event
 * ledger can store.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export const ARTIFACT = Object.freeze({
  OK: 'ok',
  MISSING_REPORT: 'missing_report',
  MISSING_SCORE: 'missing_score',
  MISSING_TRACKER: 'missing_tracker',
  MISSING_PDF: 'missing_pdf',
  MISSING_VERDICT: 'missing_verdict',
  SKIPPED: 'skipped',
});

const SCORE_RE = /\*\*Score:\*\*\s*\d+(?:\.\d+)?\s*\/\s*5/i;
const YAML_SCORE_RE = /^score:\s*['"]?\d+(?:\.\d+)?/m;
const VERDICT_RE = /VERDICT:\s*\d+(?:\.\d+)?\s*\/\s*5/i;
const REPORT_NAME_RE = /^(\d+)-.+\.md$/i;
const MIN_REPORT_BYTES = 200;
const MIN_PDF_BYTES = 100;
const MIN_VERDICT_BYTES = 40;

/**
 * @param {{ kind?: string, tenantRoot: string, input?: string, sinceMs?: number, runId?: string }} opts
 */
export function verifyJobArtifacts(opts) {
  const kind = String(opts.kind || 'evaluate');
  const root = opts.tenantRoot;
  if (!root) return fail(ARTIFACT.MISSING_REPORT, 'no tenant root');

  if (kind === 'evaluate' || kind === 'score') return verifyScore(root, opts.sinceMs);
  // cv-export's `input` is maxPages ("1"/"2"), NOT a report number — passing it
  // through made verifyPdf demand a filename containing digit "1", so every
  // date-named export (cv-2026-08-23.pdf) failed as missing_pdf. Any fresh PDF counts.
  if (kind === 'cv-export') return verifyPdf(root, opts.sinceMs, '');
  if (kind === 'pdf') return verifyPdf(root, opts.sinceMs, opts.input);
  if (kind === 'research' || kind === 'fix-portal') {
    return verifyResearch(root, opts.sinceMs, opts.runId);
  }
  return { ok: true, artifactClass: ARTIFACT.SKIPPED };
}

function fail(artifactClass, message) {
  return { ok: false, artifactClass, message };
}

function ok() {
  return { ok: true, artifactClass: ARTIFACT.OK };
}

function filesSince(dir, sinceMs, test) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    if (test && !test(name, abs, st)) continue;
    out.push({ name, abs, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function verifyScore(root, sinceMs) {
  const reports = filesSince(join(root, 'reports'), sinceMs, (name, abs, st) => {
    if (!name.endsWith('.md')) return false;
    return st.size >= MIN_REPORT_BYTES;
  });
  if (reports.length === 0) {
    return fail(ARTIFACT.MISSING_REPORT, 'incomplete: missing_report');
  }

  let scored = null;
  for (const file of reports) {
    let body = '';
    try {
      body = readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    if (SCORE_RE.test(body) || YAML_SCORE_RE.test(body)) {
      scored = { file, body };
      break;
    }
  }
  if (!scored) return fail(ARTIFACT.MISSING_SCORE, 'incomplete: missing_score');

  const m = scored.file.name.match(REPORT_NAME_RE);
  const num = m ? String(Number(m[1])) : '';
  if (!num || !trackerHasReport(root, num, scored.file.name)) {
    return fail(ARTIFACT.MISSING_TRACKER, 'incomplete: missing_tracker');
  }
  return ok();
}

function trackerHasReport(root, num, filename) {
  const tracker = join(root, 'data', 'applications.md');
  if (!existsSync(tracker)) return false;
  let body = '';
  try {
    body = readFileSync(tracker, 'utf8');
  } catch {
    return false;
  }
  if (body.includes(`reports/${filename}`)) return true;
  const padded = num.padStart(3, '0');
  const link = new RegExp(
    String.raw`\[(?:#?${num}|${padded})\]\([^)]*reports/${padded || num}`,
  );
  if (link.test(body)) return true;
  return body.includes(`reports/${padded}-`) || body.includes(`reports/${num}-`);
}

function verifyPdf(root, sinceMs, input) {
  const needle = String(input || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const pdfs = filesSince(join(root, 'output'), sinceMs, (name, abs, st) => {
    if (!name.toLowerCase().endsWith('.pdf')) return false;
    if (st.size < MIN_PDF_BYTES) return false;
    if (needle && /^\d+$/.test(needle)) {
      return name.includes(needle) || name.includes(needle.padStart(3, '0'));
    }
    return true;
  });
  if (pdfs.length === 0) return fail(ARTIFACT.MISSING_PDF, 'incomplete: missing_pdf');
  return ok();
}

function verifyResearch(root, sinceMs, runId) {
  const dirs = [
    join(root, 'reports'),
    join(root, 'interview-prep'),
    join(root, '.career-ops-web', 'research'),
  ];
  for (const dir of dirs) {
    const files = filesSince(dir, sinceMs, (name, abs, st) => {
      if (st.size < MIN_VERDICT_BYTES) return false;
      return name.endsWith('.md') || name.endsWith('.txt') || (runId && name.includes(runId));
    });
    for (const file of files) {
      let body = '';
      try {
        body = readFileSync(file.abs, 'utf8');
      } catch {
        continue;
      }
      if (VERDICT_RE.test(body)) return ok();
    }
  }
  return fail(ARTIFACT.MISSING_VERDICT, 'incomplete: missing_verdict');
}
