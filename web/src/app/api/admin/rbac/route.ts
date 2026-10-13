import { withTenant } from "@/lib/tenant/http";
import { getConfig, patchActiveConfig } from "@/lib/app-config";
import {
  CAP,
  applyPlanCapOverrides,
  can,
  currentAccount,
  currentPlanCapOverrides,
  denialReason,
  rbacMatrix,
} from "@/lib/entitlements";
import { appendRbacAudit, readAuditTail } from "@/lib/rbac-audit";

type PlanCapsOverride = NonNullable<ReturnType<typeof applyPlanCapOverrides>>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function denyUnlessOperator() {
  const actor = currentAccount();
  if (can(actor, CAP.ADMIN_RBAC)) return null;
  return Response.json({ error: denialReason(actor, CAP.ADMIN_RBAC) }, { status: 403 });
}

/**
 * Re-apply the persisted override to this process. Every instance converges on
 * the config store within one refresh TTL; calling it here also self-heals a
 * process that started before the last publish.
 */
async function syncOverridesFromConfig(): Promise<PlanCapsOverride | null> {
  const config = (await getConfig()) as { rbacPlanCapsJson?: string };
  const raw = typeof config.rbacPlanCapsJson === "string" ? config.rbacPlanCapsJson.trim() : "";
  if (!raw) {
    if (currentPlanCapOverrides()) applyPlanCapOverrides(null);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Persisted state is corrupt — fall back to defaults loudly, never half-apply.
    console.error("[rbac] stored rbacPlanCapsJson is not valid JSON; using defaults");
    if (currentPlanCapOverrides()) applyPlanCapOverrides(null);
    return null;
  }
  const applied = currentPlanCapOverrides();
  if (JSON.stringify(applied) !== JSON.stringify(parsed)) {
    try {
      applyPlanCapOverrides(parsed as Record<string, string[]>);
    } catch (err) {
      console.error("[rbac] stored override failed validation; using defaults:", err);
      applyPlanCapOverrides(null);
      return null;
    }
  }
  return parsed as PlanCapsOverride;
}

/**
 * GET — the full permission matrix for the console: roles × capabilities ×
 * plans with limits, the live override state, and the audit tail.
 */
async function handleGET() {
  const denied = denyUnlessOperator();
  if (denied) return denied;

  const persisted = await syncOverridesFromConfig();
  return Response.json({
    matrix: rbacMatrix(),
    persistedOverride: persisted,
    audit: readAuditTail(50),
  });
}

/**
 * PUT — edit the plan-capability matrix live. Body:
 * { planCaps: Record<string, string[]> | null }
 *
 * `null` resets to release defaults. Validation errors come back as 400 with
 * the precise reason; nothing partial ever persists or applies.
 */
async function handlePUT(req: Request) {
  const denied = denyUnlessOperator();
  if (denied) return denied;
  const actor = currentAccount();

  let body: { planCaps?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (body.planCaps === undefined) {
    return Response.json({ error: "planCaps is required (object keyed by plan id, or null to reset)" }, { status: 400 });
  }

  const before: PlanCapsOverride | null = currentPlanCapOverrides();
  let applied: PlanCapsOverride | null;
  try {
    applied = applyPlanCapOverrides(body.planCaps as Record<string, string[]> | null);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const published = await patchActiveConfig(
    { rbacPlanCapsJson: applied ? JSON.stringify(applied) : "" },
    applied ? "Operator updated the RBAC plan-capability matrix" : "Operator reset the RBAC matrix to defaults",
  );
  if (!published.ok) {
    // Roll the in-process copy back so memory never drifts from what persisted.
    applyPlanCapOverrides(before ?? null);
    return Response.json({ error: published.errors?.join("; ") ?? "config publish failed" }, { status: 400 });
  }

  appendRbacAudit({
    action: applied ? "rbac.planCaps.set" : "rbac.planCaps.reset",
    actor: actor?.accountId ?? "operator",
    field: "planCaps",
    before: before ?? null,
    after: applied ?? null,
  });

  return Response.json({ ok: true, matrix: rbacMatrix(), persistedOverride: applied });
}

export const GET = withTenant(handleGET);
export const PUT = withTenant(handlePUT);
