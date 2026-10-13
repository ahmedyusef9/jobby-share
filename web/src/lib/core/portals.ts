import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { tenantRoot, platformRoot } from "@/lib/tenant";
import { DEFAULT_FILTERS, cleanChips, type ExploreFilters } from "@/lib/explore";

/**
 * ACL for portals.yml — the core's scan-filter config (a CONTRACT entry-point,
 * see reference_web_core_sync_protocol). The Explorer NEVER mutates the user's
 * real portals.yml: it writes an EPHEMERAL filter file and points the scanner at
 * it via CAREER_OPS_PORTALS, so an ad-hoc search can't clobber the curated config.
 * We also read the real portals.yml + config/profile.yml (tolerantly) only to
 * SEED sensible defaults for the first search.
 *
 * Filter semantics mirror scan.mjs::buildTitleFilter / buildLocationFilter:
 *   title positive → substring match (empty = everything matches)
 *   title negative → substring reject
 *   location always_allow > block > allow (case-insensitive substring)
 */
type FilterLists = Pick<ExploreFilters, "positive" | "negative" | "allow" | "block" | "alwaysAllow">;

function listFrom(v: unknown): string[] {
  return cleanChips(v);
}

/** Serialize filters into a minimal, valid portals.yml. Scalars go through
 *  JSON.stringify (a valid YAML double-quoted scalar) so arbitrary keywords —
 *  colons, quotes, leading dashes — can never break the document or inject YAML. */
export function serializePortals(f: FilterLists): string {
  const block = (key: string, items: string[]) =>
    items.length ? `  ${key}:\n` + items.map((k) => `    - ${JSON.stringify(k)}`).join("\n") + "\n" : "";

  let out = "# Ephemeral Explorer filters — generated per-search, safe to delete.\n";
  if (f.positive.length || f.negative.length) {
    out += "title_filter:\n";
    out += block("positive", f.positive);
    out += block("negative", f.negative);
  }
  if (f.allow.length || f.block.length || f.alwaysAllow.length) {
    out += "location_filter:\n";
    out += block("always_allow", f.alwaysAllow);
    out += block("allow", f.allow);
    out += block("block", f.block);
  }
  return out;
}

/** Write the ephemeral filter file to a temp path; caller cleans it up. */
export function writeTempPortals(f: FilterLists): string {
  const file = path.join(os.tmpdir(), `career-ops-explore-${randomUUID()}.yml`);
  fs.writeFileSync(file, serializePortals(f), "utf8");
  return file;
}

export function cleanupTempPortals(file: string): void {
  try {
    if (file.startsWith(os.tmpdir()) && file.includes("career-ops-explore-")) fs.unlinkSync(file);
  } catch {
    /* best-effort */
  }
}

function loadYaml(rel: string): Record<string, unknown> | null {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(tenantRoot(), rel), "utf8"));
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Tolerantly seed first-search defaults from the user's real config. Reads
 * portals.yml (title_filter / location_filter) and falls back to
 * config/profile.yml (target_roles, location) for the positive keywords when
 * portals has none. Never throws — a bare checkout just yields DEFAULT_FILTERS.
 */
export function seedExploreFilters(): { filters: ExploreFilters; seededFrom: string[] } {
  const filters: ExploreFilters = { ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats], profileIds: [...DEFAULT_FILTERS.profileIds] };
  const seededFrom: string[] = [];

  const portals = loadYaml("portals.yml");
  if (portals) {
    const tf = (portals.title_filter ?? {}) as Record<string, unknown>;
    const lf = (portals.location_filter ?? {}) as Record<string, unknown>;
    filters.positive = listFrom(tf.positive);
    filters.negative = listFrom(tf.negative);
    filters.allow = listFrom(lf.allow);
    filters.block = listFrom(lf.block);
    filters.alwaysAllow = listFrom(lf.always_allow);
    if (filters.positive.length || filters.allow.length || filters.block.length) seededFrom.push("portals.yml");
  }

  if (filters.positive.length === 0) {
    const profile = loadYaml("config/profile.yml");
    const roles = (profile?.target_roles ?? {}) as Record<string, unknown>;
    const fromRoles = listFrom([
      ...(typeof roles.primary === "string" ? [roles.primary] : []),
      ...(Array.isArray(roles.archetypes) ? roles.archetypes : []),
    ]);
    if (fromRoles.length) {
      filters.positive = fromRoles;
      seededFrom.push("profile.yml");
    }
  }

  return { filters, seededFrom };
}

/**
 * The SHIPPED default title/location exclusion lists (templates/portals.example.yml),
 * never a tenant's own file — the comparison baseline for provenance below.
 * Tolerant like the rest of this module: an unreadable/missing template never throws.
 */
function loadTemplateExclusions(): { negative: string[]; block: string[] } {
  try {
    const doc = yaml.load(
      fs.readFileSync(path.join(platformRoot(), "templates", "portals.example.yml"), "utf8"),
    ) as Record<string, unknown> | null;
    const tf = (doc?.title_filter ?? {}) as Record<string, unknown>;
    const lf = (doc?.location_filter ?? {}) as Record<string, unknown>;
    return { negative: listFrom(tf.negative), block: listFrom(lf.block) };
  } catch {
    return { negative: [], block: [] };
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

/**
 * Distinguish a bundled onboarding default a member never touched from a
 * genuine explicit preference, for the title/location EXCLUSION fields only
 * (positive/allow already have a real per-profile source of truth — the
 * profile's own queries/locations — exclusions don't).
 *
 * A profile carries no exclusion field of its own (scripts/search-profiles.mjs
 * schema), so when a profile drives Explore/ranking, portals.yml's
 * title_filter.negative / location_filter.block is either (a) stale bundled
 * cruft from onboarding that was never customized for ANY search — safe to
 * drop for this pass — or (b) something the member actually edited, in which
 * case it is a general preference ("no internships", "not in Tel Aviv") that
 * applies regardless of which profile is active, and dropping it would
 * silently discard a real choice (#42 review). There is no per-entry
 * provenance recorded, so this never guesses at the SEMANTIC meaning of
 * individual keywords (never hardcodes a profession) — it only asks "is the
 * list, as a whole, still byte-for-byte what onboarding shipped?" Any edit at
 * all — one entry removed, one added, a full rewrite — flips the WHOLE list
 * to "explicit" rather than trying to guess which entries are the edit.
 */
export function explicitExclusions(
  filters: Pick<ExploreFilters, "negative" | "block">,
): Pick<ExploreFilters, "negative" | "block"> {
  const template = loadTemplateExclusions();
  return {
    negative: sameSet(filters.negative, template.negative) ? [] : filters.negative,
    block: sameSet(filters.block, template.block) ? [] : filters.block,
  };
}

export { listFrom as normalizeKeywords };
