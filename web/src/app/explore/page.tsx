import fs from "node:fs";
import { ExplorerView } from "@/components/explore/explorer-view";
import { seedExploreFilters, explicitExclusions } from "@/lib/core/portals";
import { readInbox, readApplications } from "@/lib/career-ops";
import { tenantRoot } from "@/lib/tenant";
import { DEFAULT_FILTERS } from "@/lib/explore";
import { withTenantPage } from "@/lib/tenant/http";
import { listProfiles, type SearchProfile } from "@/lib/core/search-profiles";

// Read live data at request time so a bare checkout (or `next build` with no
// CAREER_OPS_ROOT) never fails — discovery seeds are best-effort.
export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  return withTenantPage(() => {
    let seed: { filters: typeof DEFAULT_FILTERS; seededFrom: string[] } = { filters: DEFAULT_FILTERS, seededFrom: [] };
    try {
      seed = seedExploreFilters();
    } catch {
      /* bare checkout → defaults */
    }
    let rootExists = false;
    try {
      rootExists = fs.existsSync(tenantRoot());
    } catch {
      /* ignore */
    }
    let profiles: SearchProfile[] = [];
    try {
      profiles = listProfiles(tenantRoot());
    } catch {
      /* no store yet */
    }
    const enabled = profiles.filter((p) => p.enabled);
    if (enabled.length) {
      // Discover overlays queries/locations from each profile; don't surface portals.yml
      // roles at all — but its title/location exclusions may or may not be this profile's
      // business. A profile has no exclusion field of its own, so explicitExclusions()
      // decides per field: still the untouched onboarding default (e.g. stale Ruby/Java/FPGA
      // excludes from a software-profile install) → drop it; anything the member actually
      // edited (e.g. "Internship", "Tel Aviv") → a real preference, keep it regardless of
      // which profile is active (#42 review — a blanket clear silently discarded these).
      const preserved = explicitExclusions(seed.filters);
      seed.filters = {
        ...seed.filters,
        profileIds: enabled.map((p) => p.id),
        positive: [],
        allow: [],
        negative: preserved.negative,
        block: preserved.block,
      };
    }
    return (
      <ExplorerView
        seed={seed}
        inboxSnapshot={readInbox()}
        appsSnapshot={readApplications()}
        rootExists={rootExists}
        profiles={profiles}
      />
    );
  });
}
