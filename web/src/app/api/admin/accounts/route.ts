import { withTenant } from "@/lib/tenant/http";
import {
  ACCOUNT_STATUS,
  getAccount,
  listAccounts,
  setAccountPlan,
  setAccountRole,
  setAccountStatus,
} from "@/lib/accounts";
import { CAP, PLAN, ROLE, can, currentAccount, denialReason } from "@/lib/entitlements";
import { appendRbacAudit } from "@/lib/rbac-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AccountRow = {
  accountId: string;
  tenantId: string;
  role?: string;
  plan?: string;
  status?: string;
  emails?: string[];
  cohort?: string | null;
  createdAt?: string;
  lastSeenAt?: string;
};

/**
 * Operator gate. Runs server-side on every method — hiding the nav item is not a
 * gate, and the check is on the session's role, never on anything in the request.
 */
function denyUnlessOperator(capability: string) {
  const actor = currentAccount();
  if (can(actor, capability)) return null;
  return Response.json({ error: denialReason(actor, capability) }, { status: 403 });
}

/**
 * GET — the tenant list. Metadata only: who exists, on what plan, when they were
 * last seen. Never CV text, company names, report bodies or key material — the
 * console shows the shape of usage, never the substance of someone's job search.
 */
async function handleGET() {
  const denied = denyUnlessOperator(CAP.ADMIN_CONSOLE);
  if (denied) return denied;

  const accounts = ((await listAccounts()) as AccountRow[]).map((a) => ({
    accountId: a.accountId,
    tenantId: a.tenantId,
    email: a.emails?.[0] ?? null,
    role: a.role ?? "member",
    plan: a.plan ?? PLAN.ALPHA,
    status: a.status ?? "active",
    cohort: a.cohort ?? null,
    createdAt: a.createdAt ?? null,
    lastSeenAt: a.lastSeenAt ?? null,
  }));

  return Response.json({ accounts, plans: Object.values(PLAN), roles: Object.values(ROLE) });
}

/**
 * PATCH — change one account's plan, status or role.
 * Body: { accountId: string, plan?: string, status?: "active" | "suspended", role?: string }
 *
 * Every accepted mutation appends an audit row (BL-054). Role changes kill the
 * account's live sessions by design (setAccountRole bumps sessionVersion);
 * plan and status changes apply on the next request without a kick.
 */
async function handlePATCH(req: Request) {
  const denied = denyUnlessOperator(CAP.ADMIN_MANAGE_ACCOUNTS);
  if (denied) return denied;
  const actor = currentAccount();

  let body: { accountId?: unknown; plan?: unknown; status?: unknown; role?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  if (typeof body.accountId !== "string" || !body.accountId.trim()) {
    return Response.json({ error: "accountId is required" }, { status: 400 });
  }
  if (body.accountId === "operator") {
    return Response.json({ error: "the operator account cannot be modified" }, { status: 400 });
  }

  const target = await getAccount(body.accountId);
  const changed: string[] = [];

  if (body.plan !== undefined) {
    const plans = Object.values(PLAN) as string[];
    if (typeof body.plan !== "string" || !plans.includes(body.plan)) {
      return Response.json({ error: `plan must be one of ${plans.join(", ")}` }, { status: 400 });
    }
    if (!(await setAccountPlan(body.accountId, body.plan))) {
      return Response.json({ error: "account not found" }, { status: 404 });
    }
    appendRbacAudit({
      action: "account.plan.set",
      actor: actor?.accountId ?? "operator",
      accountId: body.accountId,
      tenantId: target?.tenantId ?? null,
      field: "plan",
      before: target?.plan ?? null,
      after: body.plan,
    });
    changed.push("plan");
  }

  if (body.status !== undefined) {
    // Deletion is the user's own action with its grace period; an operator may
    // suspend or reactivate, but not delete someone's job search from here.
    const allowed = [ACCOUNT_STATUS.ACTIVE, ACCOUNT_STATUS.SUSPENDED] as string[];
    if (typeof body.status !== "string" || !allowed.includes(body.status)) {
      return Response.json({ error: `status must be one of ${allowed.join(", ")}` }, { status: 400 });
    }
    if (!(await setAccountStatus(body.accountId, body.status))) {
      return Response.json({ error: "account not found" }, { status: 404 });
    }
    appendRbacAudit({
      action: "account.status.set",
      actor: actor?.accountId ?? "operator",
      accountId: body.accountId,
      tenantId: target?.tenantId ?? null,
      field: "status",
      before: target?.status ?? null,
      after: body.status,
    });
    changed.push("status");
  }

  if (body.role !== undefined) {
    const roles = Object.values(ROLE) as string[];
    if (typeof body.role !== "string" || !roles.includes(body.role)) {
      return Response.json({ error: `role must be one of ${roles.join(", ")}` }, { status: 400 });
    }
    if (!(await setAccountRole(body.accountId, body.role))) {
      return Response.json({ error: "account not found" }, { status: 404 });
    }
    appendRbacAudit({
      action: "account.role.set",
      actor: actor?.accountId ?? "operator",
      accountId: body.accountId,
      tenantId: target?.tenantId ?? null,
      field: "role",
      before: target?.role ?? ROLE.MEMBER,
      after: body.role,
    });
    changed.push("role");
  }

  if (changed.length === 0) {
    return Response.json({ error: "nothing to change" }, { status: 400 });
  }
  return Response.json({ ok: true, changed });
}

export const GET = withTenant(handleGET);
export const PATCH = withTenant(handlePATCH);
