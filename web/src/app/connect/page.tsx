import { McpConnectPage } from "@/components/mcp-connect";
import { withTenantPage } from "@/lib/tenant/http";

export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  return withTenantPage(() => <McpConnectPage />);
}
