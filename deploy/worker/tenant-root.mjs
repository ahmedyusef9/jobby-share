import { AsyncLocalStorage } from "node:async_hooks";
import {
  platformRoot,
  providerEnvFor,
  tenantChildEnv as baseTenantChildEnv,
  tenantRootFor,
} from "../../scripts/resolve-root.mjs";
import { getKeyForJob, tenantProviderEnv } from "../../scripts/key-store.mjs";
import { ensureDefaultTenantMigrated } from "../../web/src/lib/tenant/migrate.mjs";

/**
 * Which tenant the job currently being processed belongs to (JOBBY-BL-047).
 *
 * This used to be `process.env.JOBBY_TENANT_ID` — ONE value for the whole worker
 * container, defaulting to `default`. Every queued job therefore ran in that
 * directory no matter who enqueued it: a member's scan read the operator's
 * portals.yml, wrote into the operator's data/, and spent the operator's API key.
 * The same class of bug the key store fixed for inline runs, still live here.
 *
 * AsyncLocalStorage rather than an env assignment because the worker's
 * concurrency is configurable — with two jobs in flight, a process-global would
 * be the identical bug wearing a different hat.
 */
const jobTenant = new AsyncLocalStorage();

/**
 * Run one job's work with its tenant in scope.
 *
 * Refuses a job that names no tenant. Falling back to a default here is what
 * caused the bug: a job with no owner has to run somewhere, and every somewhere
 * is somebody's directory.
 */
export function runForJob(job, fn) {
  const tenantId = String(job?.data?.tenantId ?? "").trim();
  if (!tenantId) {
    throw new Error(
      `job ${job?.id} carries no tenantId — refusing to run it in somebody else's directory`,
    );
  }
  return jobTenant.run({ tenantId }, fn);
}

/** Tenant this worker process is running a job for. */
export function workerTenantId() {
  const ctx = jobTenant.getStore();
  if (!ctx?.tenantId) throw new Error("no tenant in scope — call runForJob() first");
  return ctx.tenantId;
}

/** Working directory for the job in scope. */
export function tenantRoot() {
  return tenantRootFor(workerTenantId());
}

/** Child env for the job in scope, pinned to its tenant. */
export function tenantChildEnv(extra = {}) {
  return baseTenantChildEnv(extra, workerTenantId());
}

/**
 * Provider env for one CLI, keyed to the tenant this job belongs to.
 * Same helper the web app uses, so a queued job and an inline run resolve keys
 * identically — the worker must never fall back to the server's own env.
 */
export function jobProviderEnv(cliId) {
  return tenantProviderEnv(cliId, workerTenantId());
}

export function migrateDefaultTenant() {
  return ensureDefaultTenantMigrated(platformRoot());
}

export { getKeyForJob, platformRoot, providerEnvFor };
