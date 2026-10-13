/**
 * Scan progress, derived from emitted events (JOBBY-BL-054).
 *
 * The rule this exists to enforce: **progress is computed from what actually
 * happened, never from a claim about it.** A model saying "70% done" is not
 * evidence; 7 of 10 source pages completed is. Everything here folds events into
 * counters, so a scan that burns effort and produces nothing is visible as
 * numbers rather than as a spinner.
 *
 * Storage is a file per scan in the tenant's own directory — the same shape and
 * the same isolation as run snapshots. The database keeps the summary; the file
 * keeps the detail, because a page-level event stream is far too chatty to be a
 * row each.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Keep the tail readable without letting a long sweep grow unbounded. */
const MAX_RECENT = 40;

/** A scan that has emitted nothing yet. */
export function emptyProgress(meta = {}) {
  return {
    scanId: meta.scanId ?? null,
    tenantId: meta.tenantId ?? null,
    kind: meta.kind ?? 'scan',
    startedAt: meta.startedAt ?? Date.now(),
    endedAt: null,
    status: 'running',
    sources: {},
    counts: {
      companiesScanned: 0,
      boardsScanned: 0,
      unreachable: 0,
      discovered: 0,
      duplicates: 0,
      filtered: 0,
      /*
       * Kept apart from `filtered` on purpose (JOBBY-BL-055). `filtered` counts
       * postings discovery never admitted; these two count postings that were
       * admitted and then refused an LLM call — the first because the cheap gates
       * disqualified them, the second because the run's budget ran out. Summed
       * into one number, nobody could tell "your filters are too narrow" from
       * "your budget is too small", which are opposite fixes.
       */
      prefilterDropped: 0,
      deferred: 0,
      evaluated: 0,
      llmCalls: 0,
      tokens: 0,
    },
    recent: [],
  };
}

/**
 * Fold one event into the state. Pure — this is the testable heart.
 *
 * @param {ReturnType<typeof emptyProgress>} state
 * @param {{kind: string} & Record<string, any>} event
 */
export function foldEvent(state, event) {
  if (!event || typeof event.kind !== 'string') return state;
  const next = {
    ...state,
    sources: { ...state.sources },
    counts: { ...state.counts },
    recent: [...state.recent, { ...event, at: event.at ?? Date.now() }].slice(-MAX_RECENT),
  };
  const c = next.counts;

  switch (event.kind) {
    case 'atsStart':
      next.sources[event.ats] = { total: Number(event.companies) || 0, scanned: 0, matches: 0, done: false };
      break;
    case 'progress': {
      const s = next.sources[event.ats] ?? { total: 0, scanned: 0, matches: 0, done: false };
      next.sources[event.ats] = {
        ...s,
        total: Number(event.total) || s.total,
        scanned: Number(event.scanned) || s.scanned,
        matches: Number(event.matches) || s.matches,
      };
      break;
    }
    case 'atsDone': {
      const s = next.sources[event.ats] ?? { total: 0, scanned: 0, matches: 0, done: false };
      next.sources[event.ats] = { ...s, done: true };
      c.unreachable += Number(event.unreachable) || 0;
      break;
    }
    case 'offer':
      c.discovered += 1;
      break;
    case 'duplicate':
      c.duplicates += 1;
      break;
    case 'filtered':
      c.filtered += 1;
      break;
    case 'filteredBatch':
      // The portal scanner reports removals as totals per reason, not per row.
      c.filtered += Number(event.filtered) || 0;
      break;
    case 'boardsScanned':
      c.boardsScanned = Number(event.boards) || 0;
      break;
    case 'prefilter':
      // The cheap stage's verdict on a whole batch, emitted once per run.
      c.prefilterDropped += Number(event.dropped) || 0;
      c.deferred = Number(event.deferred) || 0;
      next.prefilter = {
        pending: Number(event.pending) || 0,
        selected: Number(event.selected) || 0,
        dropped: Number(event.dropped) || 0,
        deferred: Number(event.deferred) || 0,
        budget: Number(event.budget) || 0,
      };
      break;
    case 'evaluated':
      c.evaluated += 1;
      c.llmCalls += Number(event.llmCalls) || 1;
      c.tokens += Number(event.tokens) || 0;
      break;
    case 'companiesScanned':
      c.companiesScanned = Number(event.companies) || c.companiesScanned;
      break;
    case 'unreachable':
      c.unreachable = Number(event.unreachable) || c.unreachable;
      break;
    case 'matches':
      // The scanner's own total. Trust it over our line count when it disagrees:
      // a dropped line loses an offer event, and undercounting looks like failure.
      if (Number(event.matches) > c.discovered) c.discovered = Number(event.matches);
      break;
    default:
      break;
  }
  return next;
}

/**
 * How far along, as a fraction, from source pages actually completed.
 *
 * Returns null rather than a guess when no source has announced its size — an
 * honest "unknown" beats a fabricated percentage.
 *
 * @param {ReturnType<typeof emptyProgress>} state
 */
export function completion(state) {
  const sources = Object.values(state?.sources ?? {});
  const total = sources.reduce((n, s) => n + (s.total || 0), 0);
  if (!total) return null;
  const scanned = sources.reduce((n, s) => n + Math.min(s.scanned || 0, s.total || 0), 0);
  return Math.max(0, Math.min(1, scanned / total));
}

/**
 * Whether this scan did any useful work.
 *
 * The question you actually wanted answered: is it making progress, or grinding?
 * Spending LLM calls while discovering nothing new is the shape of a broken run.
 *
 * @param {ReturnType<typeof emptyProgress>} state
 */
export function isProductive(state) {
  const c = state?.counts ?? {};
  if ((c.discovered || 0) > 0) return true;
  if ((c.evaluated || 0) > 0) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Persistence — one file per scan, inside the tenant's own directory
 * ------------------------------------------------------------------ */

function scansDir(tenantRoot) {
  return path.join(tenantRoot, '.career-ops-web', 'scans');
}

/** @param {string} tenantRoot @param {string} scanId */
export function scanPath(tenantRoot, scanId) {
  const safe = String(scanId).replace(/[^a-z0-9_.-]/gi, '');
  return path.join(scansDir(tenantRoot), `${safe}.json`);
}

/** @param {string} tenantRoot @param {string} scanId */
export function readProgress(tenantRoot, scanId) {
  try {
    return JSON.parse(fs.readFileSync(scanPath(tenantRoot, scanId), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} tenantRoot @param {object} state */
export function writeProgress(tenantRoot, state) {
  if (!state?.scanId) return;
  const file = scanPath(tenantRoot, state.scanId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

/** Newest first, for the Workers view. @param {string} tenantRoot */
export function listProgress(tenantRoot, limit = 20) {
  let names = [];
  try {
    names = fs.readdirSync(scansDir(tenantRoot)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    try {
      rows.push(JSON.parse(fs.readFileSync(path.join(scansDir(tenantRoot), name), 'utf8')));
    } catch {
      /* a half-written file is skipped, never fatal */
    }
  }
  return rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, limit);
}

/**
 * A live recorder: folds events and flushes to disk, throttled.
 *
 * Throttled because a full sweep emits a progress line per page; writing each one
 * would turn a read-mostly file into a hot loop.
 *
 * @param {string} tenantRoot
 * @param {{scanId: string, tenantId?: string, kind?: string}} meta
 */
export function createRecorder(tenantRoot, meta, opts = {}) {
  const flushMs = opts.flushMs ?? 1000;
  let state = emptyProgress(meta);
  let lastFlush = 0;
  writeProgress(tenantRoot, state);

  return {
    get state() {
      return state;
    },
    record(event) {
      state = foldEvent(state, event);
      const now = Date.now();
      if (now - lastFlush >= flushMs) {
        lastFlush = now;
        writeProgress(tenantRoot, state);
      }
      return state;
    },
    finish(outcome = 'ok', extra = {}) {
      state = { ...state, status: outcome, endedAt: Date.now(), ...extra };
      writeProgress(tenantRoot, state);
      return state;
    },
  };
}
