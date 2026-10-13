/**
 * MCP guards layer for the web app. Implementation lives in
 * scripts/mcp-guards.mjs so tests and the worker cannot drift.
 */
export {
  MAX_BODY_BYTES,
  TOOL_DAILY_BUDGETS,
  AUTH_FAILURE_LOCKOUT_AFTER,
  AUTH_LOCKOUT_MINUTES,
  validateAgainstSchema,
  consumeToolBudget,
  toolBudgetState,
  recordAuthFailure,
  clearAuthFailures,
  isAuthLocked,
  __resetGuards,
} from "../../../../scripts/mcp-guards.mjs";
