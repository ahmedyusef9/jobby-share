/**
 * Signup batches and capacity slots, stored in Appwrite (JOBBY-BL-044, BL-046).
 *
 * Registration is OPEN. There is no invite list, no code and no allow-list: the
 * only question is whether the round is accepting people and whether it is full.
 * Admitting somebody creates a `capacity_slots` row; capacity is the operator's
 * number on the batch, raised at runtime (10 → 15) with no deploy.
 *
 * Decisions live in release-state.mjs (pure, exhaustively tested). This module is
 * only storage and the claim operation.
 */
import {
  BATCH_STATE,
  FULL_MESSAGE,
  batchBecameFull,
  capacityOf,
  evaluateSignup,
  transitionBatch,
} from './release-state.mjs';
import {
  Q,
  appwriteConfigured,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from './appwrite-rest.mjs';

const COL_BATCHES = 'batches';
const COL_SLOTS = 'capacity_slots';

export { BATCH_STATE, capacityOf };

/**
 * Slot document id. Appwrite only allows a-z A-Z 0-9 . - _ — `#` 400s
 * ("Invalid documentId"), which the in-memory test fake does not catch.
 */
export function slotDocumentId(batchId, n) {
  return `${batchId}_${n}`;
}

/** The batch currently accepting signups, or null. */
export async function openBatch() {
  if (!appwriteConfigured()) return null;
  const rows = await listDocuments(COL_BATCHES, [
    Q.equal('state', [BATCH_STATE.OPEN]),
    Q.limit(1),
  ]);
  return rows[0] ?? null;
}

export async function listBatches() {
  if (!appwriteConfigured()) return [];
  return listDocuments(COL_BATCHES, [Q.limit(100)]);
}

/** Slot rows for a batch. One row = one account admitted. @param {string} batchId */
export async function slotsFor(batchId) {
  if (!appwriteConfigured()) return [];
  return listDocuments(COL_SLOTS, [Q.equal('batchId', [batchId]), Q.limit(1000)]);
}

/**
 * May this person sign up? Reads the open batch and how many slots are taken, then
 * defers to the state machine so the rules stay in one tested place.
 *
 * @param {{email: string}} applicant
 */
export async function checkSignup(applicant) {
  const batch = await openBatch();
  if (!batch) {
    /*
     * No OPEN batch. The common reason by far is that the round filled up, and
     * "sign-ups are not open" is the wrong thing to tell that person — it sounds
     * permanent and gives them nothing to do. Look for a full round and say so.
     */
    const full = await listDocuments(COL_BATCHES, [
      Q.equal('state', [BATCH_STATE.FULL]),
      Q.limit(1),
    ]);
    if (full.length) return { allowed: false, reason: FULL_MESSAGE };
    return { allowed: false, reason: 'Sign-ups are not open right now.' };
  }
  const taken = (await slotsFor(batch.batchId)).length;
  const decision = evaluateSignup(batch, taken, applicant);
  // The caller needs the limit to claim a slot; passing it back means it does not
  // re-read the batch and risk acting on a different number than was just checked.
  return decision.allowed ? { ...decision, capacity: batch.capacity } : decision;
}

/**
 * Take a capacity slot, atomically.
 *
 * The slot id encodes its index — `{batchId}_{n}` — and Appwrite guarantees
 * document ids are unique, so creating one either succeeds or returns 409. That is
 * a real mutex: two people racing for the last place cannot both win. A counter
 * compared with `claimed < capacity` would not serialise anything, because both
 * racers read the same number before either writes.
 *
 * Indices are always probed from 0, so a released hole is reused. The loop is
 * bounded by capacity (alpha is 10).
 *
 * @param {string} batchId
 * @param {number} capacity
 * @param {string} accountId  placeholder before the identity exists; see attachSlot
 */
export async function claimSlot(batchId, capacity, accountId) {
  const total = Number.isFinite(capacity) ? capacity : 0;
  const now = new Date().toISOString();

  for (let n = 0; n < total; n++) {
    const slotId = slotDocumentId(batchId, n);
    try {
      await createDocument(COL_SLOTS, slotId, {
        batchId,
        slotIndex: n,
        claimedBy: accountId,
        claimedAt: now,
      });
    } catch (err) {
      // Somebody else took this index between the count and the create. Try the
      // next one rather than failing — they raced us to a place, not to the round.
      if (err?.status === 409) continue;
      throw err;
    }

    await closeIfFull(batchId, total);
    return { ok: true, slotId, batchId };
  }

  // Every index up to capacity is occupied: the round genuinely filled up while
  // this request was in flight.
  await closeIfFull(batchId, total);
  return { ok: false, error: FULL_MESSAGE };
}

/**
 * Move the batch to `full` once the last slot is gone, in the same operation, so
 * the signup form stops accepting people the moment it actually runs out.
 *
 * @param {string} batchId @param {number} capacity
 */
async function closeIfFull(batchId, capacity) {
  const batch = await getDocument(COL_BATCHES, batchId);
  if (!batch || batch.state !== BATCH_STATE.OPEN) return;
  const taken = (await slotsFor(batchId)).length;
  if (!batchBecameFull(taken, capacity)) return;
  const t = transitionBatch(batch, BATCH_STATE.FULL);
  if (t.ok) await updateDocument(COL_BATCHES, batch.$id, { state: BATCH_STATE.FULL });
}

/**
 * Bind an already-taken slot to the real account id.
 *
 * Signup claims with a placeholder before the identity exists, so this is the
 * second half of that two-step. It never contends: the mutex is already held.
 *
 * @param {string} slotId @param {string} accountId
 */
export async function attachSlot(slotId, accountId) {
  await updateDocument(COL_SLOTS, slotId, { claimedBy: accountId });
  return { ok: true };
}

/**
 * Give a slot back when the signup that held it failed.
 *
 * Only safe because the caller claims BEFORE creating the identity: at this point
 * no account exists, so freeing the slot strands nobody. Never call this on a slot
 * whose account was actually created — suspend the account instead.
 *
 * @param {string} slotId
 */
export async function releaseSlot(slotId) {
  const slot = await getDocument(COL_SLOTS, slotId);
  await deleteDocument(COL_SLOTS, slotId);
  // Last-place failed signup flips the batch to `full` before the identity
  // exists. Without reopening, checkSignup would keep saying the round is full
  // while a slot sits empty.
  if (slot?.batchId) {
    const batch = await getDocument(COL_BATCHES, slot.batchId);
    if (batch?.state === BATCH_STATE.FULL) {
      const taken = (await slotsFor(slot.batchId)).length;
      if (taken < batch.capacity) {
        const t = transitionBatch(batch, BATCH_STATE.OPEN);
        if (t.ok) await updateDocument(COL_BATCHES, batch.$id, { state: BATCH_STATE.OPEN });
      }
    }
  }
  return { ok: true };
}

/**
 * Whether an account holds a capacity slot.
 *
 * The sign-in gate uses this so an identity that exists in Appwrite but never
 * completed a signup — a crashed request, a slot released after the user was
 * created — cannot sign in and provision a tenant anyway.
 *
 * @param {string} accountId
 */
export async function hasSlot(accountId) {
  if (!appwriteConfigured()) return false;
  if (!accountId) return false;
  const rows = await listDocuments(COL_SLOTS, [Q.equal('claimedBy', [accountId]), Q.limit(1)]);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ *
 * Operator actions
 * ------------------------------------------------------------------ */

/**
 * @param {{batchId: string, appVersion: string, capacity: number, plan?: string,
 *          configVersion?: string, notes?: string}} spec
 */
export async function createBatch(spec) {
  const now = new Date().toISOString();
  return createDocument(COL_BATCHES, spec.batchId, {
    batchId: spec.batchId,
    appVersion: spec.appVersion,
    configVersion: spec.configVersion ?? '',
    state: BATCH_STATE.DRAFT,
    plan: spec.plan ?? 'alpha',
    capacity: spec.capacity,
    notes: spec.notes ?? '',
    createdAt: now,
  });
}

/** @param {string} batchId @param {string} to */
export async function setBatchState(batchId, to) {
  const batch = await getDocument(COL_BATCHES, batchId);
  if (!batch) return { ok: false, error: 'batch not found' };

  const t = transitionBatch(batch, to);
  if (!t.ok) return t;

  const patch = { state: t.state };
  if (to === BATCH_STATE.OPEN) patch.openedAt = new Date().toISOString();
  if (to === BATCH_STATE.CLOSED) patch.closedAt = new Date().toISOString();
  await updateDocument(COL_BATCHES, batch.$id, patch);
  return { ok: true, state: t.state };
}

/**
 * Raise (or lower) the limit. This is the whole "10 → 15" operation.
 *
 * Raising past the taken count reopens a full batch, because a full round with room
 * in it is exactly what the operator just created. Lowering never evicts anybody —
 * existing slots keep their accounts; it only stops new ones.
 *
 * @param {string} batchId @param {number} capacity
 */
export async function setCapacity(batchId, capacity) {
  const batch = await getDocument(COL_BATCHES, batchId);
  if (!batch) return { ok: false, error: 'batch not found' };
  const n = Number(capacity);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'capacity must be a number' };

  const taken = (await slotsFor(batchId)).length;
  await updateDocument(COL_BATCHES, batch.$id, { capacity: n });

  if (batch.state === BATCH_STATE.FULL && n > taken) {
    const t = transitionBatch({ ...batch, capacity: n }, BATCH_STATE.OPEN);
    if (t.ok) await updateDocument(COL_BATCHES, batch.$id, { state: BATCH_STATE.OPEN });
  } else if (batch.state === BATCH_STATE.OPEN && n <= taken) {
    const t = transitionBatch({ ...batch, capacity: n }, BATCH_STATE.FULL);
    if (t.ok) await updateDocument(COL_BATCHES, batch.$id, { state: BATCH_STATE.FULL });
  }

  return { ok: true, capacity: n, ...capacityOf(taken, n) };
}

/** Batch plus its capacity counts, for the operator screen. */
export async function batchSummary(batchId) {
  const batch = await getDocument(COL_BATCHES, batchId);
  if (!batch) return null;
  const slots = await slotsFor(batchId);
  return { batch, capacity: capacityOf(slots.length, batch.capacity), slots };
}
