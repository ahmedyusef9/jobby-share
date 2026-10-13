/**
 * resolve-query-source — turn enabled search profiles into per-profile ephemeral
 * portals files, so each profile runs as its own isolated scan pass (M2 + the
 * isolation extension: rows are tagged per-profile downstream).
 *
 * Per-profile (NOT union): for each enabled profile (sorted by id), copy the real
 * `portals.yml` then override `title_filter.positive` ← profile.queries and
 * `location_filter.allow` ← profile.locations. `tracked_companies` and every
 * other block are preserved — scan.mjs needs no second config path.
 *
 * Modes:
 *   'profiles'        — one or more enabled profiles; caller runs scan once per run
 *   'portals-fallback'— no profiles file / empty; use the real portals.yml as-is
 *   fail-closed       — file exists but ALL profiles disabled → throws (never "everything")
 *
 * Caller MUST call cleanup() to remove temp files.
 *
 * Pure ESM JS so the CLI imports it directly; the web re-exports from
 * `web/src/lib/core/resolve-query-source.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as yaml from 'js-yaml';
import { enabledProfiles, profilesPath } from './search-profiles.mjs';

export const PROFILES_REL = path.join('config', 'search-profiles.json');

/** @param {string} root */
function realPortalsPath(root) {
  return path.join(root, 'portals.yml');
}

/**
 * @param {string} root tenant root
 * @param {object} [opts]
 * @param {string} [opts.portalsPath] override the real portals.yml path (tests)
 * @returns {{ mode: 'profiles' | 'portals-fallback', runs: PerProfileRun[], cleanup: () => void }}
 */
export function resolveQuerySource(root, opts = {}) {
  const portalsPath = opts.portalsPath || realPortalsPath(root);
  const storeFile = profilesPath(root);

  // No store / empty → fallback to portals.yml as-is (no temp file).
  let storeExists = false;
  try {
    storeExists = fs.existsSync(storeFile);
  } catch {
    storeExists = false;
  }
  if (!storeExists) {
    return { mode: 'portals-fallback', runs: [{ portalsPath, profileId: '', profileTitle: '' }], cleanup: () => {} };
  }

  const enabled = enabledProfiles(root);
  if (enabled.length === 0) {
    // File exists but nothing enabled → fail closed. Never silently scan "everything".
    throw Object.assign(new Error('all search profiles are disabled — enable one or remove config/search-profiles.json'), { status: 400 });
  }

  const tempFiles = [];
  const baseDoc = readPortalsBase(portalsPath);
  const runs = enabled.map((p) => {
    const doc = structuredClone(baseDoc);
    doc.title_filter = doc.title_filter || {};
    doc.title_filter.positive = p.queries;
    doc.location_filter = doc.location_filter || {};
    doc.location_filter.allow = p.locations;
    const tmp = path.join(os.tmpdir(), `jobby-profile-${p.id}-${randomBytes(4).toString('hex')}.yml`);
    fs.writeFileSync(tmp, yaml.dump(doc, { lineWidth: 100, noRefs: true }), 'utf8');
    tempFiles.push(tmp);
    return { portalsPath: tmp, profileId: p.id, profileTitle: p.title };
  });

  const cleanup = () => {
    for (const f of tempFiles) {
      try {
        if (f.startsWith(os.tmpdir()) && f.includes('jobby-profile-')) fs.unlinkSync(f);
      } catch {
        /* best-effort */
      }
    }
  };

  return { mode: 'profiles', runs, cleanup };
}

/** @param {string} portalsPath */
function readPortalsBase(portalsPath) {
  try {
    const doc = yaml.load(fs.readFileSync(portalsPath, 'utf8'));
    return doc && typeof doc === 'object' ? /** @type {Record<string, unknown>} */ (doc) : {};
  } catch {
    return {};
  }
}

/**
 * @typedef {Object} PerProfileRun
 * @property {string} portalsPath
 * @property {string} profileId
 * @property {string} profileTitle
 */
