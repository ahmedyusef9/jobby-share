import "server-only";
import { CAP, can, currentAccount, denialReason, engineDeniedResponse, isOperator } from "@/lib/entitlements";
/**
 * One gate for every request that can reach a language model (JOBBY-BL-048).
 *
 * The operator does not pay for anybody else's model usage. That is a product
 * rule, so it belongs in one place that every model route calls, not in each
 * route's own idea of what to check.
 *
 * Three questions, in the order that gives the most useful refusal:
 *
 *   1. May this account run this engine?      — the host's CLIs are not theirs
 *   2. Does this account have its own key?    — `requireOwnApiKey`
 *   3. Does its plan include this feature?    — CAP.SCORE_JOB, CV_CHAT, …
 *
 * Scanning and discovery never come through here: they spend no *tokens*, but they
 * spend the host (CPU and ATS HTTP). That cap lives in `scripts/scan-quota.mjs`,
 * not here.
 */

/**
 * Always 403. `needsKey` tells the client which fix to offer — "add a key" and
 * "your plan does not include this" are both refusals, but only one of them is
 * something the user can act on right now.
 */
function deny(error: string, needsKey = false): Response {
  return new Response(JSON.stringify({ error, needsKey }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Refuse a model request, or return null to let it through.
 *
 * @param cliId    engine the caller asked for, when the route takes one
 * @param capability plan capability this route represents, when it maps to one
 */
export async function modelAccessDenied(
  cliId?: string | null,
  capability?: string,
): Promise<Response | null> {
  const account = currentAccount();

  // 1. Whose credentials would this spend?
  if (cliId !== undefined) {
    const denied = engineDeniedResponse(cliId);
    if (denied) return denied;
  }

  // 2. Zero-key rule (BL-058): members never run models through jobby — not
  //    on the host's credentials and not on their own keys. The refusal points
  //    at the MCP surface, where their own assistant does the work.
  if (!isOperator(account)) {
    return deny(
      "This step would run an AI model, and in this release jobby runs no models for members. " +
        "Connect ChatGPT or Claude from Account → MCP and do it there on your own subscription.",
      false,
    );
  }

  // 3. Does the plan include it?
  if (capability && !can(account, capability)) {
    return deny(denialReason(account, capability));
  }

  return null;
}

export { CAP };
