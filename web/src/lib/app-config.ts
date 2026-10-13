/**
 * Live application config for the web app. Implementation lives in
 * scripts/config-store.mjs so the worker and the Next server cannot drift.
 *
 * Reading: `getConfig()` refreshes if stale and returns the frozen object.
 * Publishing a new version makes every running instance pick it up within one
 * TTL — no restart, no dropped sessions.
 */
export {
  currentConfig,
  currentConfigSource,
  currentConfigVersion,
  getConfig,
  nextConfigVersion,
  patchActiveConfig,
  publishConfigVersion,
  refreshConfig,
} from "../../../scripts/config-store.mjs";

export { CONFIG_SCHEMA, defaultConfig, validateConfig } from "../../../scripts/release-state.mjs";
