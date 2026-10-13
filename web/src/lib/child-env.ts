/**
 * Child-process env for the web app. Implementation lives in scripts/child-env.mjs
 * so the worker and the Next server cannot drift.
 */
export {
  CHILD_ENV_BASE_KEYS,
  CLI_PROVIDER_KEYS,
  pickChildEnv,
  providerEnvFor,
} from "../../../scripts/child-env.mjs";
