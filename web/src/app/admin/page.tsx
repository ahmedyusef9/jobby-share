import { notFound } from "next/navigation";
import { AdminPanel } from "@/components/admin-panel";
import { CAP, can, currentAccount } from "@/lib/entitlements";
import { withTenantPage } from "@/lib/tenant/http";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  return withTenantPage(() => {
    // Server-side gate. A member gets a 404 rather than a 403 so the page does not
    // confirm to a non-operator that an admin area exists here at all.
    if (!can(currentAccount(), CAP.ADMIN_CONSOLE)) notFound();
    return <AdminPanel />;
  });
}
