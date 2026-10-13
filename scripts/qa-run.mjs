#!/usr/bin/env node
/**
 * qa-run.mjs — the ledger the manual/agent half of a QA round writes into.
 *
 * The Playwright suite reports itself. Everything a human or an agent verifies
 * by hand — the expired-key pill, the QR render, ChatGPT actually connecting —
 * has no reporter, so it evaporates the moment the round ends. This is that
 * reporter: one append-only JSONL file per round, keyed by criterion id from
 * qa/features.yml, so a manual verdict is as citable as a test result.
 *
 *   node scripts/qa-run.mjs open   --round 9 --base-url http://localhost:3001
 *   node scripts/qa-run.mjs record ACCESS-L2-SCOPE-07 pass --round 9 \
 *        --evidence 'HTTP 401, body "expired — mint a fresh key under Account → MCP"' \
 *        --artifact test-results/agent/expired-401.png
 *   node scripts/qa-run.mjs list   --round 9
 *
 * Append-only by design: a later entry supersedes an earlier one for the same
 * criterion, but the earlier verdict stays readable. A round that flipped a
 * FAIL to a PASS after a fix should show both, not just the ending it liked.
 */

import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as yamlModule from 'js-yaml';

const yaml = yamlModule.default || yamlModule;

const VERDICTS = new Set(['pass', 'fail', 'blocked', 'skipped', 'na']);
const MODES = new Set(['agent', 'manual', 'auto']);
const RUNS_DIR = 'qa/runs';
const MANIFEST = 'qa/features.yml';

const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a));

function isFlagValue(token) {
  const i = argv.indexOf(token);
  return i > 0 && argv[i - 1].startsWith('--');
}
function opt(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
function optAll(name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
}
function die(message, code = 2) {
  console.error(`qa-run: ${message}`);
  process.exit(code);
}

function loadCriteria() {
  if (!existsSync(MANIFEST)) die(`manifest not found at ${MANIFEST}`);
  const manifest = yaml.load(readFileSync(MANIFEST, 'utf8'));
  const index = new Map();
  for (const feature of manifest.features || []) {
    for (const criterion of feature.criteria || []) {
      index.set(criterion.id, { ...criterion, feature: feature.id, risk: criterion.risk || feature.risk });
    }
  }
  return index;
}

function roundFile(round) {
  if (!round) die('--round <n> is required');
  return path.join(RUNS_DIR, `round-${round}.jsonl`);
}

function head() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function append(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '');
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function readRound(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        die(`${file} line ${i + 1} is not valid JSON`);
      }
    });
}

// ---------------------------------------------------------------- commands

if (command === 'open') {
  const round = opt('round');
  const file = roundFile(round);
  const entry = {
    ts: new Date().toISOString(),
    kind: 'round-open',
    round: Number(round),
    commit: head(),
    base_url: opt('base-url') || process.env.JOBBY_E2E_BASE_URL || null,
    mcp_url: opt('mcp-url') || process.env.JOBBY_MCP_PUBLIC_URL || null,
    actor: opt('actor') || process.env.QA_ACTOR || 'unknown',
    note: opt('note') || null,
  };
  if (!entry.commit) die('not a git checkout — a round must be pinned to a commit');
  append(file, entry);
  console.log(`opened round ${round} at ${entry.commit} → ${file}`);
  process.exit(0);
}

if (command === 'record') {
  const [criterionId, verdict] = positional;
  const round = opt('round');
  if (!criterionId || !verdict) {
    die('usage: qa-run.mjs record <criterion-id> <pass|fail|blocked|skipped|na> --round N --evidence "..."');
  }
  if (!VERDICTS.has(verdict)) die(`unknown verdict "${verdict}" — use one of ${[...VERDICTS].join(', ')}`);

  const criteria = loadCriteria();
  const criterion = criteria.get(criterionId);
  // Refusing an unknown id is the whole point: a verdict that maps to no
  // requirement is a note, not coverage, and would never appear in a report.
  if (!criterion) die(`"${criterionId}" is not a criterion in ${MANIFEST}`);

  const mode = opt('mode') || 'agent';
  if (!MODES.has(mode)) die(`unknown mode "${mode}" — use one of ${[...MODES].join(', ')}`);

  const evidence = opt('evidence');
  // pass/fail without evidence is exactly the claim this file exists to prevent.
  if ((verdict === 'pass' || verdict === 'fail') && !evidence) {
    die(`--evidence is required for a ${verdict} verdict; quote the observed text, status code or file`);
  }

  const entry = {
    ts: new Date().toISOString(),
    kind: 'verdict',
    round: Number(round),
    criterion: criterionId,
    feature: criterion.feature,
    risk: criterion.risk,
    verdict,
    mode,
    evidence: evidence || null,
    artifacts: optAll('artifact'),
    commit: head(),
    actor: opt('actor') || process.env.QA_ACTOR || 'unknown',
  };
  append(roundFile(round), entry);
  console.log(`round ${round}: ${criterionId} → ${verdict.toUpperCase()} (${mode})`);
  process.exit(0);
}

if (command === 'list') {
  const entries = readRound(roundFile(opt('round')));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(entries, null, 2));
    process.exit(0);
  }
  for (const e of entries) {
    if (e.kind === 'round-open') {
      console.log(`\nround ${e.round} opened ${e.ts} at ${e.commit} by ${e.actor}`);
      console.log(`  base ${e.base_url || '—'}  mcp ${e.mcp_url || '—'}\n`);
      continue;
    }
    console.log(`  ${e.verdict.toUpperCase().padEnd(8)} ${e.criterion.padEnd(24)} ${e.mode.padEnd(7)} ${e.evidence || ''}`);
  }
  console.log('');
  process.exit(0);
}

die('usage: qa-run.mjs <open|record|list> ... (see the header of this file)', 1);
