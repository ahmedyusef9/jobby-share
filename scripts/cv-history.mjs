#!/usr/bin/env node
// Private version history for the CV and exported resumes.
//
// cv.md, config/profile.yml and output/ are all gitignored in this repo, and
// deliberately so: `origin` is a public fork of career-ops, and a stray
// `git add -A` that swept in a CV would publish a phone number and address to
// GitHub. The cost of that safety is that the CV has no history at all — the web
// editor's answer to an accidental overwrite is a single `.bak` file, and
// api/cv/route.ts says as much ("no git recovery").
//
// This gives the CV real history without weakening that boundary: a second git
// repository under .cv-history/, itself ignored by the outer repo, with no
// remote and a guard that refuses to run if one ever appears. Nothing here can
// be pushed.
//
// Lives in scripts/ rather than at the repo root: root *.mjs is in
// update-system.mjs's SYSTEM_PATHS and is replaced wholesale on every update.
//
// Usage:
//   node scripts/cv-history.mjs snapshot [--label <text>] [--attach <path>]...
//   node scripts/cv-history.mjs list [--json] [--limit N]
//   node scripts/cv-history.mjs show <ref> [--file cv.md]
//   node scripts/cv-history.mjs diff [<ref>] [<ref>]
//   node scripts/cv-history.mjs restore <ref> [--file cv.md]

import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_DIR = join(ROOT, '.cv-history');
const GIT_TIMEOUT_MS = 30_000;

// Tracked by default on every snapshot. Each maps a live repo path to a stable
// path inside the history repo, so diffs across snapshots line up.
const TRACKED = [
  { from: 'cv.md', to: 'cv.md' },
  { from: 'config/profile.yml', to: 'profile.yml' },
  { from: 'modes/_profile.md', to: 'modes/_profile.md' },
];

const FALLBACK_IDENTITY = { name: 'career-ops cv-history', email: 'cv-history@localhost' };

function git(args, options = {}) {
  return execFileSync('git', ['-C', HISTORY_DIR, ...args], {
    encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
}

function gitQuiet(args) {
  try {
    return git(args).trim();
  } catch {
    return '';
  }
}

/**
 * Commit identity for the history repo.
 *
 * Falls back to a local placeholder when git has no global identity, so a first
 * snapshot cannot fail with "Please tell me who you are" on a fresh machine.
 *
 * @returns {{name: string, email: string}}
 */
function identity() {
  const read = key => {
    try {
      return execFileSync('git', ['-C', ROOT, 'config', '--get', key], {
        encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };
  return {
    name: read('user.name') || FALLBACK_IDENTITY.name,
    email: read('user.email') || FALLBACK_IDENTITY.email,
  };
}

/**
 * Refuse to touch a history repo that has a remote.
 *
 * The whole point of this store is that it cannot leave the machine. A remote
 * would make `git push` from inside .cv-history/ publish the CV, so its presence
 * is treated as a hard error rather than a warning.
 */
function assertNoRemote() {
  const remotes = gitQuiet(['remote']);
  if (remotes !== '') {
    throw new Error(
      `.cv-history/ has a git remote configured (${remotes.split('\n').join(', ')}). ` +
      'This store holds personal data and must stay local. Remove it with: ' +
      `git -C .cv-history remote remove ${remotes.split('\n')[0]}`,
    );
  }
}

/**
 * Guarantee the outer repo ignores .cv-history/.
 *
 * Written to .git/info/exclude rather than .gitignore: .gitignore is tracked
 * upstream, so an entry there is a fork diff that conflicts on every merge,
 * while info/exclude is local-only and invisible to upstream. Doing this in code
 * rather than as one-time setup means the guarantee survives a fresh clone —
 * without it, the first `git add -A` after a re-clone would stage the CV history.
 */
function ensureOuterIgnore() {
  const excludePath = join(ROOT, '.git', 'info', 'exclude');
  if (!existsSync(dirname(excludePath))) return; // not a git repo; nothing to protect

  const entry = '.cv-history/';
  let current = '';
  try {
    current = readFileSync(excludePath, 'utf-8');
  } catch {
    // Absent file is normal on a fresh clone — created below.
  }
  if (current.split('\n').some(line => line.trim() === entry)) return;

  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  writeFileSync(excludePath, `${current}${separator}${entry}\n`);
}

function ensureRepo() {
  ensureOuterIgnore();

  if (!existsSync(join(HISTORY_DIR, '.git'))) {
    mkdirSync(HISTORY_DIR, { recursive: true });
    execFileSync('git', ['-C', HISTORY_DIR, 'init', '--quiet', '--initial-branch=main'], {
      encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'],
    });
    writeFileSync(
      join(HISTORY_DIR, 'README.md'),
      '# CV history\n\n' +
      'Private, local-only version history for cv.md, the profile, and exported\n' +
      'resume PDFs. Written by `scripts/cv-history.mjs`. Never add a remote:\n' +
      'this repository contains personal contact details.\n',
    );
    git(['add', 'README.md']);
    commit('Initialize CV history');
  }
  assertNoRemote();
}

function commit(subject, body = '') {
  const who = identity();
  const message = body ? `${subject}\n\n${body}\n` : `${subject}\n`;
  git([
    '-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`,
    'commit', '--quiet', '--no-gpg-sign', '-m', message,
  ]);
}

// ------------------------------------------------------------------- snapshot

function stageFile(fromPath, toRelative) {
  const source = resolve(ROOT, fromPath);
  if (!existsSync(source)) return null;

  const target = join(HISTORY_DIR, toRelative);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  git(['add', '--', toRelative]);
  return { path: toRelative, bytes: statSync(source).size };
}

function snapshot(options) {
  ensureRepo();

  // --file selects which file to read in show/diff/restore; snapshot never reads
  // it. Accepting it silently meant `snapshot --file resume.pdf` reported success
  // while storing nothing, so say what the caller meant instead of no-oping.
  if (options.file) {
    throw new Error(`snapshot has no --file; use --attach ${options.file} to store a rendered resume`);
  }

  const staged = [];
  for (const entry of TRACKED) {
    const result = stageFile(entry.from, entry.to);
    if (result) staged.push(result);
  }

  // Exported resumes live under output/, which is gitignored too. Keeping the
  // rendered artefact alongside the source is the point: it answers "what did I
  // actually send them" months later, which cv.md alone cannot.
  for (const file of options.files) {
    const result = stageFile(file, join('resumes', basename(file)));
    if (!result) throw new Error(`file not found: ${file}`);
    staged.push(result);
  }

  if (staged.length === 0) {
    throw new Error('nothing to snapshot — cv.md, config/profile.yml and modes/_profile.md are all missing');
  }

  // git diff --cached --quiet exits 1 when something is staged.
  let hasChanges = false;
  try {
    git(['diff', '--cached', '--quiet']);
  } catch {
    hasChanges = true;
  }

  if (!hasChanges) {
    const head = gitQuiet(['rev-parse', '--short', 'HEAD']);
    return { created: false, ref: head, files: staged.map(f => f.path) };
  }

  const label = options.label?.trim() || `snapshot ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  commit(label, staged.map(f => `${f.path} (${f.bytes} bytes)`).join('\n'));

  return { created: true, ref: gitQuiet(['rev-parse', '--short', 'HEAD']), label, files: staged.map(f => f.path) };
}

// ----------------------------------------------------------------------- read

function list(options) {
  ensureRepo();
  const raw = gitQuiet([
    'log', `--max-count=${options.limit}`, '--date=iso-strict',
    '--pretty=format:%h\u001f%ad\u001f%s\u001f%D',
  ]);
  if (raw === '') return [];

  return raw.split('\n').map(line => {
    const [ref, date, subject, refs] = line.split('\u001f');
    const files = gitQuiet(['show', '--name-only', '--pretty=format:', ref])
      .split('\n').map(s => s.trim()).filter(Boolean);
    return { ref, date, label: subject, refs, files };
  });
}

function show(ref, file) {
  ensureRepo();
  return git(['show', `${ref}:${file}`]);
}

function diff(refA, refB, file) {
  ensureRepo();
  const paths = file ? ['--', file] : [];
  // No second ref: compare the snapshot against what is live in the repo now.
  if (!refB) {
    const target = file ?? 'cv.md';
    const source = resolve(ROOT, TRACKED.find(t => t.to === target)?.from ?? target);
    if (!existsSync(source)) throw new Error(`nothing live to compare: ${target}`);
    const staged = join(HISTORY_DIR, target);
    mkdirSync(dirname(staged), { recursive: true });
    copyFileSync(source, staged);
    return gitQuiet(['diff', refA, '--', target]) || '(no differences)';
  }
  return gitQuiet(['diff', refA, refB, ...paths]) || '(no differences)';
}

function restore(ref, file) {
  ensureRepo();
  const entry = TRACKED.find(t => t.to === file);
  if (!entry) throw new Error(`${file} is not one of the tracked files: ${TRACKED.map(t => t.to).join(', ')}`);

  const content = show(ref, file);
  const target = resolve(ROOT, entry.from);
  // Never overwrite without a copy of what was there: the file being restored
  // over is itself gitignored in the outer repo and has no other recovery path.
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(target, `${target}.bak-${stamp}`);
  }
  writeFileSync(target, content);
  return { restored: entry.from, from: ref };
}

// ----------------------------------------------------------------------- main

function parseArgs(argv) {
  const options = { command: argv[0], files: [], label: null, json: false, limit: 30, file: null, refs: [] };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i += 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };

    if (arg === '--label') options.label = value();
    else if (arg === '--file') options.file = value();
    else if (arg === '--attach') options.files.push(value());
    else if (arg === '--json') options.json = true;
    else if (arg === '--limit') {
      const limit = Number(value());
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
      options.limit = limit;
    } else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else options.refs.push(arg);
  }

  return options;
}

const USAGE = `Usage:
  node scripts/cv-history.mjs snapshot [--label <text>] [--attach <path>]...
  node scripts/cv-history.mjs list [--json] [--limit N]
  node scripts/cv-history.mjs show <ref> [--file cv.md]
  node scripts/cv-history.mjs diff [<ref>] [<ref>] [--file cv.md]
  node scripts/cv-history.mjs restore <ref> [--file cv.md]`;

function main() {
  const options = parseArgs(process.argv.slice(2));

  switch (options.command) {
    case 'snapshot': {
      const result = snapshot(options);
      if (options.json) return process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.created) return console.log(`No changes since ${result.ref} — nothing to snapshot.`);
      console.log(`✅ ${result.ref}  ${result.label}`);
      return console.log(`   ${result.files.join(', ')}`);
    }
    case 'list': {
      const entries = list(options);
      if (options.json) return process.stdout.write(`${JSON.stringify(entries)}\n`);
      if (entries.length === 0) return console.log('No snapshots yet. Create one: node scripts/cv-history.mjs snapshot');
      for (const entry of entries) {
        console.log(`${entry.ref}  ${entry.date.slice(0, 16).replace('T', ' ')}  ${entry.label}`);
      }
      return undefined;
    }
    case 'show': {
      if (!options.refs[0]) throw new Error('show requires a ref');
      return process.stdout.write(show(options.refs[0], options.file ?? 'cv.md'));
    }
    case 'diff': {
      const [refA = 'HEAD', refB] = options.refs;
      return console.log(diff(refA, refB, options.file));
    }
    case 'restore': {
      if (!options.refs[0]) throw new Error('restore requires a ref');
      const result = restore(options.refs[0], options.file ?? 'cv.md');
      return console.log(`✅ restored ${result.restored} from ${result.from} (previous version kept as .bak-*)`);
    }
    default:
      throw new Error(`unknown command: ${options.command ?? '(none)'}\n\n${USAGE}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`cv-history: ${err.message}`);
  if (err.stderr) console.error(String(err.stderr).trim());
  process.exit(1);
}
