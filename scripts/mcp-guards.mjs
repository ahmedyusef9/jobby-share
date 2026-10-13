/**
 * MCP guards layer (BL-072) — defense-in-depth for the public endpoint,
 * layered in front of every tools/call:
 *
 *   1. inputSchema enforcement  — args must match the tool's declared schema
 *   2. payload cap              — oversized bodies never reach dispatch
 *   3. per-tool daily buckets   — expensive tools get their own budget
 *   4. auth-failure lockout     — repeated bad keys cool the key down
 *
 * Pure functions live here so tests run without a server. The handler wires
 * them in; error shape follows JSON-RPC conventions used by mcp-jsonrpc.
 */

export const MAX_BODY_BYTES = 256 * 1024;

/** Calls/day per tool, on top of the global daily MCP counter. */
export const TOOL_DAILY_BUDGETS = {
  resume_generate: 10,
  submit_score: 50,
  fetch_page: 30,
};

export const AUTH_FAILURE_LOCKOUT_AFTER = 20;
export const AUTH_LOCKOUT_MINUTES = 15;

// ---------------------------------------------------------------- schema --

/**
 * @typedef {object} JsonSchema
 * @property {string} [type]
 * @property {Record<string, JsonSchema>} [properties]
 * @property {string[]} [required]
 * @property {boolean} [additionalProperties]
 * @property {JsonSchema} [items]
 * @property {unknown[]} [enum]
 */

/**
 * Minimal validator covering exactly what our tool schemas use:
 * object/string/number/boolean/array/enum + required + additionalProperties.
 * Returns null when valid, else a human message.
 */
export function validateAgainstSchema(
  args,
  schema,
){
  if (!schema) return null; // nothing declared — nothing to enforce
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const props = (schema && schema.properties) || {};

  for (const key of schema?.required || []) {
    if (!(key in args)) return `missing required argument: ${key}`;
  }

  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) {
      if (schema.additionalProperties === false) return `unknown argument: ${key}`;
      continue;
    }
    switch (spec.type) {
      case "string":
        if (typeof value !== "string") return `${key} must be a string`;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return `${key} must be a number`;
        break;
      case "boolean":
        if (typeof value !== "boolean") return `${key} must be a boolean`;
        break;
      case "array": {
        if (!Array.isArray(value)) return `${key} must be an array`;
        const itemType = spec.items?.type;
        if (itemType === "string" && value.some((v) => typeof v !== "string")) {
          return `${key} items must be strings`;
        }
        break;
      }
      case "object":
        if (typeof value !== "object" || Array.isArray(value)) return `${key} must be an object`;
        break;
      default:
        break; // no type constraint declared
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      return `${key} must be one of: ${spec.enum.join(", ")}`;
    }
  }
  return null;
}

// ------------------------------------------------------------- budgets --

const dayStamp = () => new Date().toISOString().slice(0, 10);
// `${day}|${tenantId}|${tool}`
const toolBuckets = new Map();

/** Consume one unit of a tool's daily budget. false = exhausted. */
export function consumeToolBudget(tenantId, tool) {
  const budget = TOOL_DAILY_BUDGETS[tool];
  if (budget === undefined) return true; // unbucketed tools ride the global counter
  const k = `${dayStamp()}|${tenantId}|${tool}`;
  const used = toolBuckets.get(k) ?? 0;
  if (used >= budget) return false;
  toolBuckets.set(k, used + 1);
  return true;
}

export function toolBudgetState(tenantId, tool) {
  const budget = TOOL_DAILY_BUDGETS[tool];
  if (budget === undefined) return null;
  const used = toolBuckets.get(`${dayStamp()}|${tenantId}|${tool}`) ?? 0;
  return { used, limit: budget };
}

// ------------------------------------------------------------- lockout --

const failures = new Map();

function pruneLockouts(now = Date.now()) {
  for (const [k, v] of failures) {
    if (v.until && v.until < now) failures.delete(k);
  }
}

/** Record a failed authentication attempt for this key id. */
export function recordAuthFailure(keyId, now = Date.now()) {
  pruneLockouts(now);
  const entry = failures.get(keyId) ?? { count: 0 };
  entry.count += 1;
  if (entry.count >= AUTH_FAILURE_LOCKOUT_AFTER) {
    entry.until = now + AUTH_LOCKOUT_MINUTES * 60_000;
  }
  failures.set(keyId, entry);
}

/** Clear failures after a successful authentication. */
export function clearAuthFailures(keyId) {
  failures.delete(keyId);
}

/** true while the key is cooling down from too many failures. */
export function isAuthLocked(keyId, now = Date.now()) {
  pruneLockouts(now);
  const entry = failures.get(keyId);
  return !!entry?.until && entry.until > now;
}

/** TEST-ONLY: wipe in-memory guard state. */
export function __resetGuards() {
  failures.clear();
  toolBuckets.clear();
}
