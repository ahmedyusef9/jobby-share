/**
 * Signup batches and capacity slots for the web app. Implementation lives in
 * scripts/batch-store.mjs so the worker and the Next server cannot drift.
 */
export {
  BATCH_STATE,
  attachSlot,
  batchSummary,
  capacityOf,
  checkSignup,
  claimSlot,
  createBatch,
  hasSlot,
  listBatches,
  openBatch,
  releaseSlot,
  setBatchState,
  setCapacity,
  slotsFor,
} from "../../../scripts/batch-store.mjs";
