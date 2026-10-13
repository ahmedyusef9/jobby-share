import { AsyncLocalStorage } from "node:async_hooks";
import { assertTenantId } from "./ids.mjs";

/** @typedef {{ tenantId: string, account?: Record<string, unknown> | null }} TenantContext */

const als = new AsyncLocalStorage();

export class MissingTenantContextError extends Error {
  status = 500;
  constructor() {
    super("tenantRoot() called without request context");
    this.name = "MissingTenantContextError";
  }
}

/**
 * @template T
 * @param {TenantContext} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTenant(ctx, fn) {
  const tenantId = assertTenantId(ctx.tenantId);
  return als.run({ ...ctx, tenantId }, fn);
}

export function tenantId() {
  const ctx = als.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx.tenantId;
}

/**
 * Account loaded at the start of this request. Null when the wrapper did not
 * stash one — callers must fail closed rather than re-read a file.
 */
export function tenantAccount() {
  return als.getStore()?.account ?? null;
}

export function hasTenantContext() {
  return als.getStore() != null;
}
