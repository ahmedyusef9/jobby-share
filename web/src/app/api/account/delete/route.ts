import { withTenant } from "@/lib/tenant/http";
import { tenantId } from "@/lib/tenant";
import { accountForTenant, requestDeletion } from "@/lib/account-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — start the 7-day deletion. Tenant id comes from the session, never
 * the body. Confirmation is the account email, typed by the user.
 *
 * Body: { confirmEmail: string }
 */
async function handlePOST(req: Request) {
  const account = await accountForTenant(tenantId());
  if (!account) {
    return Response.json({ error: "operator account cannot be deleted" }, { status: 403 });
  }

  let body: { confirmEmail?: unknown; tenantId?: unknown };
  try {
    body = (await req.json()) as { confirmEmail?: unknown; tenantId?: unknown };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  // A client-supplied tenant id is ignored on purpose. Reject loudly if one
  // arrives so a buggy caller cannot think it chose the target.
  if (body.tenantId != null) {
    return Response.json({ error: "tenant id is not accepted in the body" }, { status: 400 });
  }

  if (typeof body.confirmEmail !== "string" || !body.confirmEmail.trim()) {
    return Response.json({ error: "type your account email to confirm" }, { status: 400 });
  }

  try {
    const result = await requestDeletion(account.accountId, body.confirmEmail);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : "delete failed";
    return Response.json({ error: message }, { status });
  }
}

export const POST = withTenant(handlePOST);
