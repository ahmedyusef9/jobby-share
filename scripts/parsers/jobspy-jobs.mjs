#!/usr/bin/env node
// Launcher for jobspy-jobs.py. Forwards argv, relays stdout untouched.
//
// Why a shim instead of pointing parser.command at the venv python directly:
// providers/local-parser.mjs realpath-resolves parser.command and rejects
// anything landing outside the repo. .venv-jobspy/bin/python is a symlink into
// uv's global store, so it fails that check and the portal is silently skipped.
// `node` is a whitelisted interpreter, so this is the supported route in.
//
// Lives in scripts/ rather than providers/, which update-system.mjs replaces
// wholesale on every update.
//
// Setup (once):
//   uv venv --python 3.12 .venv-jobspy
//   uv pip install --python .venv-jobspy/bin/python python-jobspy

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VENV_PYTHON = resolve(PROJECT_ROOT, '.venv-jobspy/bin/python');
const SCRAPER = resolve(PROJECT_ROOT, 'scripts/parsers/jobspy-jobs.py');

function resolvePython() {
  const fromEnv = process.env.JOBBY_JOBSPY_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON;
  return 'python3';
}

const python = resolvePython();
if (python !== 'python3' && !existsSync(python)) {
  console.error(
    `jobspy-jobs: python at ${python} is missing. Set JOBBY_JOBSPY_PYTHON or create .venv-jobspy:\n`
    + '  uv venv --python 3.12 .venv-jobspy\n'
    + '  uv pip install --python .venv-jobspy/bin/python python-jobspy',
  );
  process.exit(1);
}

const result = spawnSync(python, [SCRAPER, ...process.argv.slice(2)], {
  cwd: PROJECT_ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (result.error) {
  console.error(`jobspy-jobs: could not run ${python}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
