/**
 * Account deletion and export for the web app. Implementation lives in
 * scripts/account-lifecycle.mjs so the worker and a cron purge cannot drift.
 */
export {
  ACCOUNT_GRACE_MS,
  accountForTenant,
  containedTenantDir,
  emailConfirmed,
  exportTenantArchive,
  graceMs,
  purgeAccount,
  purgeExpiredAccounts,
  requestDeletion,
  restoreAccount,
} from "../../../scripts/account-lifecycle.mjs";
