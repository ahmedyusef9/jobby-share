import { notFound } from "next/navigation";
import { RunsPanel } from "@/components/runs-panel";
import { CAP, can, currentAccount } from "@/lib/entitlements";
import { withTenantPage } from "@/lib/tenant/http";

export const dynamic = "force-dynamic";

export default async function AdminRunsPage() {
  return withTenantPage(() => {
    // Same posture as /admin: a member gets a 404, so the page never confirms
    // that an operator area exists here.
    if (!can(currentAccount(), CAP.ADMIN_CONSOLE)) notFound();
    return <RunsPanel />;
  });
}
