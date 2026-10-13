/**
 * Roles, plans and the capability gate. Implementation lives in
 * scripts/entitlements.mjs so the worker and the Next server cannot drift.
 */
import { operatorAccount, unknownAccount } from "@/lib/accounts";
import { tenantAccount, tenantId } from "@/lib/tenant";
import {
  HOST_ENGINE_DENIAL,
  mayUseEngine,
} from "../../../scripts/entitlements.mjs";

export {
  CAP,
  PLAN,
  PLAN_LIMITS,
  ROLE,
  HOST_ENGINE_DENIAL,
  HOST_SCORE_DEFERRED,
  SELF_FUNDED_ENGINES,
  applyPlanCapOverrides,
  assertSelfFundedEngine,
  can,
  currentPlanCapOverrides,
  defaultPlan,
  denialReason,
  isOperator,
  isSelfFundedEngine,
  mayUseEngine,
  planLimits,
  rbacMatrix,
} from "../../../scripts/entitlements.mjs";

export type Account = {
  accountId: string;
  tenantId: string;
  role?: string;
  plan?: string;
  status?: string;
  emails?: string[];
};

/**
 * The account behind the current request, resolved from the verified session's
 * tenant — never from a header, a query string or a request body.
 *
 * The operator signs in with the local secret and has no account row, so it is
 * synthesised here with the operator role. That keeps `can()` with one input
 * shape instead of two branches at every call site.
 */
export function currentAccount(): Account {
  /*
   * Fails closed (JOBBY-BL-049, D-014). The account is loaded once in
   * withTenant and stashed on the request context, so this stays synchronous
   * for every gate on the request path. Missing context, or a tenant Appwrite
   * does not know, is an inactive unknown — never the operator.
   */
  const cached = tenantAccount();
  if (cached) return cached as Account;
  try {
    const id = tenantId();
    if (id === "default") return operatorAccount(id) as Account;
    return unknownAccount(id) as Account;
  } catch {
    return unknownAccount("unknown") as Account;
  }
}

/**
 * 403 JSON when the caller asked for a host-owned engine. Null when the spawn
 * may proceed. Routes return this before `spawn()` so a member cannot spend the
 * container's OpenCode / Claude / Codex / Cursor login via a leftover cliId.
 */
export function engineDeniedResponse(cliId: string | null | undefined): Response | null {
  if (mayUseEngine(currentAccount(), cliId)) return null;
  return new Response(JSON.stringify({ error: HOST_ENGINE_DENIAL }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
