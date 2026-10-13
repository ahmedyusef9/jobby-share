import { createHash } from "node:crypto";

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** @param {string} id */
export function assertTenantId(id) {
  if (!TENANT_ID_RE.test(id) || id.includes("..")) {
    throw Object.assign(new Error("invalid tenant id"), { status: 400 });
  }
  return id;
}

/** @param {string} provider @param {string} sub */
export function tenantIdFromSubject(provider, sub) {
  const h = createHash("sha256").update(`${provider}:${sub}`).digest("hex").slice(0, 16);
  return assertTenantId(`t_${h}`);
}

export function defaultTenantId() {
  return "default";
}
