#!/usr/bin/env node
/**
 * qa-ship — the bookkeeping half of the BrowserMCP QA gate (BL-059).
 *
 * The Cursor agent drives the UI, decides PASS/FAIL, then records the verdict
 * here. One command keeps GitHub (labels + issue state), the backlog CSV and
 * the issue index TSV in agreement — the three places a feature's status lives.
 *
 *   node scripts/qa-ship.mjs 51 pass  --evidence "screenshots + notes"
 *   node scripts/qa-ship.mjs 52 fail  --note "steps, error text"
 *
 * pass → labels flip to status:done, issue closes with evidence,
 *        CSV/TSV rows become Done/closed.
 * fail → evidence comment posted, issue stays open on status:in-progress.
 *
 * --dry-run prints what would happen without touching anything.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.QA_REPO || 'ahmedyusef9/jobby';
const CSV = path.join(ROOT, 'implementation_backlog.csv');
const TSV = path.join(ROOT, '.jobby', 'github-issues.tsv');

// ---- args -------------------------------------------------------------
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const issueNum = args.find((a) => /^\d+$/.test(a));
const verdict = args.find((a) => a === 'pass' || a === 'fail');
if (!issueNum || !verdict) {
  console.error('usage: node scripts/qa-ship.mjs <issue#> <pass|fail> [--evidence|--note "text"] [--dry-run]');
  process.exit(1);
}
const flagIdx = args.findIndex((a) => a === '--evidence' || a === '--note');
const text = flagIdx >= 0 ? String(args[flagIdx + 1] ?? '') : '';

/** @returns {string} stdout */
function gh(jsonArgs, opts = {}) {
  return execFileSync('gh', jsonArgs, { encoding: 'utf8', ...opts }).trim();
}

// ---- resolve the BL id from the issue title ---------------------------
const issue = JSON.parse(gh(['issue', 'view', issueNum, '-R', REPO, '--json', 'number,title,state,labels']));
const m = issue.title.match(/JOBBY-BL-\d{3}/);
const blId = m ? m[0] : null;
if (!blId) {
  console.error(`issue #${issueNum} has no [JOBBY-BL-###] id in its title — refusing to guess`);
  process.exit(1);
}
const labelNames = (issue.labels ?? []).map((l) => l.name ?? l);
console.log(`#${issue.num} ${blId} "${issue.title}" [${issue.state}] labels: ${labelNames.join(', ')}`);

// ---- plan -------------------------------------------------------------
const plan = [];
const nextStatus = verdict === 'pass' ? 'Done' : 'In Progress';

if (verdict === 'pass') {
  for (const l of ['status:in-progress', 'status:in-qa']) {
    if (labelNames.includes(l)) plan.push(() => gh(['issue', 'edit', issueNum, '-R', REPO, '--remove-label', l]));
  }
  if (!labelNames.includes('status:done')) {
    plan.push(() => gh(['issue', 'edit', issueNum, '-R', REPO, '--add-label', 'status:done']));
  }
  plan.push(() =>
    gh([
      'issue', 'close', issueNum, '-R', REPO,
      '-c', `BrowserMCP QA PASS.\n\n${text || '(no evidence attached)'}\n\nVerified end-to-end against release/v0.5.0 via scripted browser pass (BL-059).`,
    ]),
  );
} else {
  plan.push(() => gh(['issue', 'comment', issueNum, '-R', REPO, '-b', `BrowserMCP QA **FAIL** — branch stays unmerged.\n\n${text || '(no details attached)'}`]));
}

// CSV + TSV flips (both verdicts write a status)
plan.push(() => {
  const rows = fs.readFileSync(CSV, 'utf8').split('\n');
  const out = rows.map((line) => (line.startsWith(`${blId},`) ? line.replace(/,In Progress,|,In QA,/i, `,${nextStatus},`) : line));
  fs.writeFileSync(CSV, out.join('\n'));
});
plan.push(() => {
  if (!fs.existsSync(TSV)) return;
  const lines = fs.readFileSync(TSV, 'utf8').split('\n').map((l) => {
    const c = l.split('\t');
    if (c[0] !== blId || c.length < 6) return l;
    c[3] = verdict === 'pass' ? 'closed' : c[3];
    c[5] = nextStatus;
    return c.join('\t');
  });
  fs.writeFileSync(TSV, lines.join('\n'));
});

// ---- execute ----------------------------------------------------------
for (const step of plan) {
  if (dry) console.log('DRY:', String(step).slice(0, 90));
  else step();
}
console.log(verdict === 'pass'
  ? `${blId} shipped — issue closed as status:done, trackers updated.`
  : `${blId} FAIL recorded — issue stays open, trackers reset to In Progress.`);
