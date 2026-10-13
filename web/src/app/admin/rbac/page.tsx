import { notFound } from "next/navigation";
import { RbacPanel } from "@/components/rbac-panel";
import { CAP, can, currentAccount } from "@/lib/entitlements";
import { withTenantPage } from "@/lib/tenant/http";

export const dynamic = "force-dynamic";

export default async function AdminRbacPage() {
  return withTenantPage(() => {
    // Same rule as /admin: a member gets a 404, not a 403, so the page does not
    // confirm that an access-control console exists here at all.
    if (!can(currentAccount(), CAP.ADMIN_RBAC)) notFound();
    return <RbacPanel />;
  });
}
