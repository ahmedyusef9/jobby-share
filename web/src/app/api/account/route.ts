import { withTenant } from "@/lib/tenant/http";
import { tenantId } from "@/lib/tenant";
import { auth } from "@/auth";
import { accountForTenant, graceMs } from "@/lib/account-lifecycle";
import { CAP, can, currentAccount } from "@/lib/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET() {
  const session = await auth();
  const account = await accountForTenant(tenantId());
  const email = session?.user?.email ?? null;
  const actor = currentAccount();
  return Response.json({
    email,
    emails: account?.emails ?? (email ? [email.toLowerCase()] : []),
    tenantId: tenantId(),
    status: account?.status ?? "active",
    operator: !account,
    canDelete: Boolean(account),
    // Nav hint only. Every admin route re-checks this server-side, so a stale
    // client value hides or shows a link and grants nothing.
    role: actor.role ?? "member",
    plan: actor.plan ?? null,
    canAdmin: can(actor, CAP.ADMIN_CONSOLE),
    graceDays: Math.round(graceMs() / (24 * 60 * 60 * 1000)),
  });
}

export const GET = withTenant(handleGET);
