import Link from "next/link";
import { Layers } from "lucide-react";
import { withTenantPage } from "@/lib/tenant/http";
import { tenantRoot } from "@/lib/tenant";
import { listProfiles } from "@/lib/core/search-profiles";
import { SearchProfilesClient } from "@/components/search-profiles-view";

export const dynamic = "force-dynamic";

export default async function SearchProfilesPage() {
  return withTenantPage(() => {
    const profiles = listProfiles(tenantRoot());
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-3">
          <Layers className="size-6 text-brand" />
          <h1 className="font-display text-2xl tracking-tight text-landing">Search profiles</h1>
        </div>
        <p className="mt-1.5 max-w-xl text-sm text-muted">
          Named searches that <strong className="font-medium text-foreground">drive Explore</strong> — e.g. “Software Engineer Israel” and “Software Engineer US”. Enable them here; run Discover on Explore. Each pass is tagged so Pipeline can filter both in one tab.
        </p>
        <p className="mt-1.5 text-xs text-faint">
          Backed by <code className="text-muted">config/search-profiles.json</code>. When at least one profile is
          enabled, these supersede <code className="text-muted">portals.yml</code> as the query source.{" "}
          <Link href="/explore" className="text-brand underline-offset-2 hover:underline">
            Open Explore
          </Link>
        </p>
        <div className="mt-6">
          <SearchProfilesClient initial={profiles} />
        </div>
      </div>
    );
  });
}
