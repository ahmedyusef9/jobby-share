import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import { seedExploreFilters, explicitExclusions } from "@/lib/core/portals";
import { enabledProfiles, type SearchProfile } from "@/lib/core/search-profiles";
import { tenantRoot } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const clean = (v: string) => v.trim().toLowerCase();

/**
 * Keyword positives for free inbox "Most match" ranking.
 *
 * An enabled search profile (M2) is the ranking source of truth for POSITIVE
 * keywords when one exists — the union of its queries, same as
 * applyProfileToFilters() does for the actual scan (explore-profile-filters.mjs).
 * A profile has no exclusion field of its own, so NEGATIVE keywords come from
 * explicitExclusions(): still-untouched onboarding defaults (e.g. stale
 * Ruby/Java/FPGA from a software-profile install) don't rank against an
 * unrelated profile, but anything the member actually edited (e.g.
 * "Internship") is a real preference that keeps applying regardless of which
 * profile is active (#42 review). Falls back to portals.yml/profile.yml (0
 * tokens either way) only when no profile is enabled.
 */
async function handleGET() {
  const { filters, seededFrom } = seedExploreFilters();

  let enabled: SearchProfile[] = [];
  try {
    enabled = enabledProfiles(tenantRoot());
  } catch {
    /* no store yet */
  }

  if (enabled.length) {
    const positive = [...new Set(enabled.flatMap((p) => p.queries.map(clean)).filter(Boolean))];
    const negative = explicitExclusions(filters).negative.map(clean).filter(Boolean);
    return NextResponse.json({
      positive,
      negative,
      seededFrom: enabled.map((p) => `profile:${p.title}`),
      note: "Keyword fit only — not an A–F evaluation score.",
    });
  }

  const positive = filters.positive.map(clean).filter(Boolean);
  const negative = filters.negative.map(clean).filter(Boolean);
  return NextResponse.json({
    positive,
    negative,
    seededFrom,
    note: "Keyword fit only — not an A–F evaluation score.",
  });
}

export const GET = withTenant(handleGET);
