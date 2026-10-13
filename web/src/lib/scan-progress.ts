/**
 * Scan progress for the web app. Implementation lives in
 * scripts/scan-progress.mjs so the worker and the Next server cannot drift.
 */
export {
  completion,
  createRecorder,
  emptyProgress,
  foldEvent,
  isProductive,
  listProgress,
  readProgress,
} from "../../../scripts/scan-progress.mjs";
