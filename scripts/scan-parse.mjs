/**
 * Scanner stdout/stderr → structured progress events (JOBBY-BL-054).
 *
 * The scanner is an upstream career-ops script. Rather than editing it — and
 * losing that edit on the next `update-system.mjs apply` — its human progress
 * lines are parsed here. One parser, two callers: the interactive Explore path in
 * the web app and the queued scan in the worker, which previously reported
 * nothing at all between "started" and "done".
 *
 * Pure: a line in, an event or null out. No I/O, no state beyond the ATS name the
 * caller carries between lines.
 */

const ATS_START_RE = /⚙\s+(\S+)\s+—\s+(\d+)\s+companies/;
const PROGRESS_RE = /(\d+)\/(\d+)\s+scanned,\s+(\d+)\s+total matches/;
const ATS_DONE_RE = /done \((\d+) unreachable boards skipped\)/;
const COMPANIES_RE = /Companies scanned:\s+(\d+)/;
const UNREACHABLE_RE = /Unreachable boards:\s+(\d+)/;
const MATCHES_RE = /New matches:\s+(\d+)/;
const OFFER_RE = /^\s*\+\s+\[([^\]]+)\]\s+(\S+)\s+\|\s+(.+)$/;

/*
 * The portal scanner (`scan.mjs`) and the reverse-ATS scanner
 * (`scan-ats-full.mjs`) print different summaries. The queued path runs the
 * first, so its vocabulary has to be here too — otherwise a queued scan records
 * companies and nothing else, which is how the first live run reported
 * "89 companies, 0 discovered" while the scanner had actually filtered rows out.
 */
const TOTAL_FOUND_RE = /Total jobs found:\s+(\d+)/;
const FILTERED_RE = /Filtered by [a-z]+:\s+(\d+) removed/;
const BOARDS_RE = /Job boards scanned:\s+(\d+)/;

/*
 * The cheap filter stage (JOBBY-BL-055) prints one verdict line per run. It is
 * the only line in a pipeline run that says how much of it was paid for, so it
 * is parsed alongside the scanners' own vocabulary.
 */
const PREFILTER_RE =
  /Prefilter:\s+(\d+) pending,\s+(\d+) selected,\s+(\d+) dropped,\s+(\d+) deferred \(budget (\d+)\)/;

/**
 * @param {string} line
 * @param {{ ats?: string }} [ctx] carries the current ATS between lines
 * @returns {{kind: string} & Record<string, unknown> | null}
 */
export function parseScanLine(line, ctx = {}) {
  const text = String(line ?? '');

  const atsM = text.match(ATS_START_RE);
  if (atsM) {
    ctx.ats = atsM[1];
    return { kind: 'atsStart', ats: atsM[1], companies: Number(atsM[2]) };
  }

  const progM = text.match(PROGRESS_RE);
  if (progM) {
    return {
      kind: 'progress',
      ats: ctx.ats ?? '',
      scanned: Number(progM[1]),
      total: Number(progM[2]),
      matches: Number(progM[3]),
    };
  }

  const doneM = text.match(ATS_DONE_RE);
  if (doneM) {
    return { kind: 'atsDone', ats: ctx.ats ?? '', unreachable: Number(doneM[1]) };
  }

  const offerM = text.match(OFFER_RE);
  if (offerM) {
    return { kind: 'offer', ats: offerM[1], company: offerM[2], title: offerM[3].trim() };
  }

  const companiesM = text.match(COMPANIES_RE);
  if (companiesM) return { kind: 'companiesScanned', companies: Number(companiesM[1]) };

  const unreachableM = text.match(UNREACHABLE_RE);
  if (unreachableM) return { kind: 'unreachable', unreachable: Number(unreachableM[1]) };

  const matchesM = text.match(MATCHES_RE);
  if (matchesM) return { kind: 'matches', matches: Number(matchesM[1]) };

  const foundM = text.match(TOTAL_FOUND_RE);
  if (foundM) return { kind: 'matches', matches: Number(foundM[1]) };

  // Several "Filtered by X" lines can appear; each reports its own removals.
  const filteredM = text.match(FILTERED_RE);
  if (filteredM) return { kind: 'filteredBatch', filtered: Number(filteredM[1]) };

  const boardsM = text.match(BOARDS_RE);
  if (boardsM) return { kind: 'boardsScanned', boards: Number(boardsM[1]) };

  const preM = text.match(PREFILTER_RE);
  if (preM) {
    return {
      kind: 'prefilter',
      pending: Number(preM[1]),
      selected: Number(preM[2]),
      dropped: Number(preM[3]),
      deferred: Number(preM[4]),
      budget: Number(preM[5]),
    };
  }

  return null;
}

/**
 * Split a chunk into complete lines, returning the trailing partial for the next
 * chunk. A progress line arriving in two pieces must not be dropped.
 *
 * @param {string} buffer @param {string} chunk
 */
export function takeLines(buffer, chunk) {
  const combined = String(buffer ?? '') + String(chunk ?? '');
  const parts = combined.split(/\r?\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}
