import path from "node:path";
import { tenantId } from "./context.mjs";
import { assertTenantId } from "./ids.mjs";

export function platformRoot() {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return path.resolve(env);
  return path.resolve(process.cwd(), "..");
}

export function tenantRoot() {
  const id = tenantId();
  return path.resolve(platformRoot(), "tenants", id);
}

/** @param {string} resolved */
export function assertInsideTenant(resolved) {
  const root = tenantRoot();
  const abs = path.resolve(resolved);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(prefix)) {
    throw Object.assign(new Error("path escapes tenant root"), { status: 400 });
  }
  return abs;
}

/** @param {...string} rel */
export function tenantFile(...rel) {
  return assertInsideTenant(path.resolve(tenantRoot(), ...rel));
}

/** @param {string | null | undefined} candidate */
export function rejectMismatchedTenantId(candidate) {
  if (candidate == null || candidate === "") return;
  const claimed = assertTenantId(candidate);
  if (claimed !== tenantId()) {
    throw Object.assign(new Error("tenant mismatch"), { status: 403 });
  }
}
