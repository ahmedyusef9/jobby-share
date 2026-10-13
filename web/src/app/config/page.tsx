import { ConfigForm } from "@/components/config-form";
import { currentAccount, isOperator } from "@/lib/entitlements";
import { withTenantPage } from "@/lib/tenant/http";

export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  return withTenantPage(() => {
    /*
     * The in-container CLIs (Claude, Codex, Cursor, OpenCode) run on logins baked
     * into the image — the operator's subscriptions. Offering them to a member
     * would be offering somebody else's account. Members score in their own
     * ChatGPT / Claude / Cursor via MCP on /connect; paste-key is operator-only.
     */
    return <ConfigForm canUseCli={isOperator(currentAccount())} />;
  });
}
