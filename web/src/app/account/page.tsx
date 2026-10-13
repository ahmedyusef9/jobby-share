import { AccountPanel } from "@/components/account-panel";
import { withTenantPage } from "@/lib/tenant/http";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  return withTenantPage(() => <AccountPanel />);
}
