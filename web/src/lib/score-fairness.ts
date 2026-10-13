/**
 * Per-tenant Score admission. Implementation lives in scripts/score-fairness.mjs
 * so the worker, the Next server, and tests cannot drift.
 */
export {
  SCORE_FAIRNESS,
  SCORE_INFLIGHT_CAP,
  SCORE_KIND,
  SCORE_MAX_ACTIVE,
  SCORE_MAX_WAITING,
  SCORE_RUN_RETRY_MS,
  ScoreFairnessError,
  decideScoreAdmission,
  isScoreFairnessError,
  releaseScoreRunLock,
  tryAcquireScoreRunLock,
  workerConcurrency,
} from "../../../scripts/score-fairness.mjs";
