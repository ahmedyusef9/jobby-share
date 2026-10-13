import fs from "node:fs";
import path from "node:path";
import { defaultTenantId } from "./ids.mjs";
import { platformRoot } from "./paths.mjs";

const USER_FILES = [
  "cv.md",
  "article-digest.md",
  "voice-dna.md",
  "portals.yml",
  "opencode.json",
  "plugins.lock",
  "config/profile.yml",
  "config/cv-facts.json",
  "config/benchmarks.yml",
  "config/plugins.yml",
  "modes/_profile.md",
  "modes/_custom.md",
  "modes/_brief.md",
  "data/intake-state.json",
];

const USER_DIRS = [
  "data",
  "documents",
  "reports",
  "output",
  "interview-prep",
  "writing-samples",
  "jds",
  "plugins.local",
  ".career-ops-web",
];

/** @param {string} p */
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} src @param {string} dest */
function movePath(src, dest) {
  if (!exists(src) || exists(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

/**
 * One-time: move the checkout's user-layer tree into tenants/default.
 * @param {string} [root]
 */
export function ensureDefaultTenantMigrated(root = platformRoot()) {
  const dest = path.join(root, "tenants", defaultTenantId());
  const marker = path.join(dest, ".jobby-tenant");
  if (exists(marker)) return { dest, moved: false };

  const hasUserData = USER_FILES.some((rel) => exists(path.join(root, rel)))
    || USER_DIRS.some((rel) => exists(path.join(root, rel)));
  fs.mkdirSync(dest, { recursive: true });
  if (!hasUserData) {
    fs.writeFileSync(marker, "default\n");
    return { dest, moved: false };
  }

  for (const rel of USER_FILES) movePath(path.join(root, rel), path.join(dest, rel));
  for (const rel of USER_DIRS) movePath(path.join(root, rel), path.join(dest, rel));
  fs.writeFileSync(marker, "default\n");
  return { dest, moved: true };
}
