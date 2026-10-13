/**
 * Scan concurrency + daily quota. Implementation lives in scripts/scan-quota.mjs
 * so the worker and the Next server cannot drift.
 */
export {
  SCAN_CONCURRENT,
  SCAN_DAILY,
  SCAN_DENIED,
  SCAN_UNAVAILABLE,
  ScanQuotaError,
  acquireRunLock,
  beginScan,
  countToday,
  endScan,
  isScanQuotaError,
  reserveScan,
  scanDailyLimit,
  usageForTenant,
} from "../../../scripts/scan-quota.mjs";
