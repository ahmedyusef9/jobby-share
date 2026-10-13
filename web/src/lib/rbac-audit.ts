/**
 * RBAC mutation audit for the web app. Implementation lives in
 * scripts/rbac-audit.mjs so the worker and the Next server cannot drift.
 */
export { appendRbacAudit, readAuditTail } from "../../../scripts/rbac-audit.mjs";
