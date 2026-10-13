import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

/**
 * Storage-layer tests for taking a capacity slot.
 *
 * The rules themselves are covered exhaustively in release-state.test.mjs. What
 * matters here is the part that cannot be a pure function: that two processes
 * racing for the LAST place produce exactly one winner, and that a failed signup
 * does not strand a place or an identity.
 *
 * Appwrite is faked at the `fetch` boundary rather than by re-implementing the
 * claim, so these exercise the real batch-store code — including its query
 * encoding, which is where the last Appwrite bug actually lived.
 */

process.env.APPWRITE_ENDPOINT = 'https://appwrite.test/v1';
process.env.APPWRITE_PROJECT_ID = 'test';
process.env.APPWRITE_API_KEY = 'test';

const {
  attachSlot,
  checkSignup,
  claimSlot,
  hasSlot,
  releaseSlot,
  setCapacity,
  slotDocumentId,
  slotsFor,
} = await import('../scripts/batch-store.mjs');

/* ------------------------------------------------------------------ *
 * A fake Appwrite with the one guarantee this design depends on:
 * document ids are unique, so a create either succeeds or 409s.
 * ------------------------------------------------------------------ */

let db;

/** a-z A-Z 0-9 and . - _ ; max 36; must not start with a special character. */
const VALID_DOCUMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Apply the JSON-encoded queries batch-store sends. */
function applyQueries(rows, url) {
  let out = rows;
  for (const raw of url.searchParams.getAll('queries[]')) {
    const q = JSON.parse(raw);
    if (q.method === 'equal') out = out.filter((r) => q.values.includes(r[q.attribute]));
    if (q.method === 'limit') out = out.slice(0, q.values[0]);
  }
  return out;
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const m = url.pathname.match(/\/collections\/([^/]+)\/documents(?:\/(.+))?$/);
  if (!m) return json(404, { message: 'no route' });

  const [, collection, rawId] = m;
  const id = rawId ? decodeURIComponent(rawId) : null;
  const store = (db[collection] ??= new Map());
  const method = init.method ?? 'GET';

  if (method === 'GET' && !id) {
    return json(200, { documents: applyQueries([...store.values()], url) });
  }
  if (method === 'GET') {
    const doc = store.get(id);
    return doc ? json(200, doc) : json(404, { message: 'not found' });
  }
  if (method === 'POST') {
    const { documentId, data } = JSON.parse(init.body);
    // Appwrite's id rules, enforced here because the first version of the slot id
    // used `#` and this fake happily accepted it — every test passed and the real
    // server answered 400 "Invalid documentId". A fake that is more permissive
    // than the thing it stands in for is worse than no fake at all.
    if (!VALID_DOCUMENT_ID.test(documentId)) {
      return json(400, { message: `Invalid documentId: ${documentId}` });
    }
    // The whole mechanism: unique ids make this a mutex.
    if (store.has(documentId)) return json(409, { message: 'Document already exists' });
    const doc = { $id: documentId, ...data };
    store.set(documentId, doc);
    return json(201, doc);
  }
  if (method === 'PATCH') {
    const doc = store.get(id);
    if (!doc) return json(404, { message: 'not found' });
    Object.assign(doc, JSON.parse(init.body).data);
    return json(200, doc);
  }
  if (method === 'DELETE') {
    return store.delete(id) ? json(200, {}) : json(404, { message: 'not found' });
  }
  return json(405, { message: 'bad method' });
};

function seedBatch({ capacity = 2, state = 'open' } = {}) {
  db.batches.set('alpha-1', {
    $id: 'alpha-1',
    batchId: 'alpha-1',
    state,
    capacity,
    plan: 'alpha',
  });
}

beforeEach(() => {
  db = { batches: new Map(), capacity_slots: new Map() };
});

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('two racers for the LAST place produce exactly one winner', async () => {
  seedBatch({ capacity: 1 });

  const [a, b] = await Promise.all([
    claimSlot('alpha-1', 1, 'acct_A'),
    claimSlot('alpha-1', 1, 'acct_B'),
  ]);

  const winners = [a, b].filter((r) => r.ok);
  assert.equal(winners.length, 1, 'comparing a counter with capacity would let both in');
  assert.equal(db.capacity_slots.size, 1, 'capacity must never be exceeded');
  assert.match([a, b].find((r) => !r.ok).error, /full/i);
});

test('two racers with room to spare both get in, on different slots', async () => {
  seedBatch({ capacity: 5 });

  const [a, b] = await Promise.all([
    claimSlot('alpha-1', 5, 'acct_A'),
    claimSlot('alpha-1', 5, 'acct_B'),
  ]);

  assert.ok(a.ok && b.ok, 'open registration must not refuse people while there is room');
  assert.notEqual(a.slotId, b.slotId, 'a 409 on one index must fall through to the next');
  assert.equal(db.capacity_slots.size, 2);
});

test('taking the last place closes the round in the same operation', async () => {
  seedBatch({ capacity: 2 });

  await claimSlot('alpha-1', 2, 'acct_A');
  assert.equal(db.batches.get('alpha-1').state, 'open', 'still room after one');

  await claimSlot('alpha-1', 2, 'acct_B');
  assert.equal(
    db.batches.get('alpha-1').state,
    'full',
    'the form must stop accepting people the moment it runs out, not on a nightly job',
  );
});

test('a full round refuses the next person with a message about the round', async () => {
  seedBatch({ capacity: 1 });
  await claimSlot('alpha-1', 1, 'acct_A');

  const decision = await checkSignup({ email: 'late@x.com' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /full/i);
  assert.doesNotMatch(decision.reason, /invit/i, 'open signup must never mention invitations');
});

test('releasing after a failed signup frees the place for somebody else', async () => {
  seedBatch({ capacity: 1 });

  const claim = await claimSlot('alpha-1', 1, 'pending:me@x.com');
  assert.equal(claim.ok, true);
  assert.match(claim.slotId, /^alpha-1_\d+$/, 'Appwrite rejects # in document ids');

  await releaseSlot(claim.slotId); // registration failed
  assert.equal(db.capacity_slots.size, 0, 'a stranded row would burn a place permanently');

  const retry = await claimSlot('alpha-1', 1, 'acct_LATER');
  assert.equal(retry.ok, true, 'the freed place is usable again');
});

test('releasing the last place reopens the round so the next person is not told it is full', async () => {
  seedBatch({ capacity: 1 });
  const claim = await claimSlot('alpha-1', 1, 'pending:fail@x.com');
  assert.equal(db.batches.get('alpha-1').state, 'full');

  await releaseSlot(claim.slotId);
  assert.equal(db.batches.get('alpha-1').state, 'open');

  const decision = await checkSignup({ email: 'next@x.com' });
  assert.equal(decision.allowed, true);
});

test('a hole at a low index is reused, not skipped until the round looks full', async () => {
  seedBatch({ capacity: 2 });
  const first = await claimSlot('alpha-1', 2, 'acct_A');
  await claimSlot('alpha-1', 2, 'acct_B');
  await releaseSlot(first.slotId);

  const retry = await claimSlot('alpha-1', 2, 'acct_C');
  assert.equal(retry.ok, true, 'starting the scan at taken-count would skip the hole and refuse');
  assert.equal(retry.slotId, first.slotId);
});

test('the slot is bound to the real account only after the identity exists', async () => {
  seedBatch({ capacity: 3 });

  const claim = await claimSlot('alpha-1', 3, 'pending:me@x.com');
  assert.equal(await hasSlot('acct_REAL'), false, 'nothing holds the place yet');

  await attachSlot(claim.slotId, 'acct_REAL');
  assert.equal(await hasSlot('acct_REAL'), true, 'sign-in checks this to block orphans');
});

test('raising capacity reopens a full round without a deploy', async () => {
  seedBatch({ capacity: 1 });
  await claimSlot('alpha-1', 1, 'acct_A');
  assert.equal(db.batches.get('alpha-1').state, 'full');

  const r = await setCapacity('alpha-1', 3);
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 2);
  assert.equal(db.batches.get('alpha-1').state, 'open', '10 → 15 is the whole operation');

  const next = await claimSlot('alpha-1', 3, 'acct_B');
  assert.equal(next.ok, true);
});

test('lowering capacity stops new people but never evicts anybody', async () => {
  seedBatch({ capacity: 4 });
  await claimSlot('alpha-1', 4, 'acct_A');
  await claimSlot('alpha-1', 4, 'acct_B');

  await setCapacity('alpha-1', 2);
  assert.equal((await slotsFor('alpha-1')).length, 2, 'existing accounts keep their place');
  assert.equal(db.batches.get('alpha-1').state, 'full');
  assert.equal(await hasSlot('acct_A'), true);
});

test('the slot id is one Appwrite will actually accept', async () => {
  // The shipped bug: `{batchId}#{n}` is rejected with 400 "Invalid documentId",
  // so signup failed on the real server while every test passed.
  assert.match(slotDocumentId('alpha-1', 0), VALID_DOCUMENT_ID);
  assert.match(slotDocumentId('alpha-1', 9), VALID_DOCUMENT_ID);
  assert.doesNotMatch(slotDocumentId('alpha-1', 0), /#/);
});
