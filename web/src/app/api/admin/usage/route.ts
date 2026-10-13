import { withTenant } from "@/lib/tenant/http";
import { accountByTenant } from "@/lib/accounts";
import { usageForTenant } from "@/lib/scan-quota";
import { CAP, can, currentAccount, denialReason } from "@/lib/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  const actor = currentAccount();
  if (!can(actor, CAP.ADMIN_CONSOLE)) {
    return Response.json({ error: denialReason(actor, CAP.ADMIN_CONSOLE) }, { status: 403 });
  }

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId")?.trim() ?? "";
  if (!tenantId) {
    return Response.json({ error: "tenantId is required" }, { status: 400 });
  }

  const account = await accountByTenant(tenantId);
  if (!account) {
    return Response.json({ error: "account not found" }, { status: 404 });
  }

  const events = await usageForTenant(tenantId, { limit: 50 });
  return Response.json({
    tenantId,
    accountId: account.accountId,
    events,
  });
}

export const GET = withTenant(handleGET);
