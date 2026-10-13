import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

process.env.APPWRITE_ENDPOINT = 'https://appwrite.test/v1';
process.env.APPWRITE_PROJECT_ID = 'test';
process.env.APPWRITE_API_KEY = 'test';
process.env.JOBBY_SCAN_DAILY_LIMIT = '5';

const {
  SCAN_CONCURRENT,
  SCAN_DAILY,
  SCAN_DENIED,
  SCAN_UNAVAILABLE,
  ScanQuotaError,
  acquireRunLock,
  beginScan,
  dailySlotId,
  decideScan,
  endScan,
  reserveScan,
  runLockId,
  scanDailyLimit,
  tenantKey,
  utcDay,
  usageForTenant,
} = await import('../scripts/scan-quota.mjs');
const { ROLE, PLAN } = await import('../scripts/entitlements.mjs');

const VALID_DOCUMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;

const member = { role: ROLE.MEMBER, plan: PLAN.ALPHA, status: 'active' };
const operator = { role: ROLE.OPERATOR, plan: PLAN.ADVANCED, status: 'active' };
const TENANT = 't_<tenant>';

test('plan scan limits apply when the test override is unset', () => {
  assert.equal(scanDailyLimit({}, member), 30);
  assert.equal(scanDailyLimit({ JOBBY_SCAN_DAILY_LIMIT: '5' }, member), 5);
});

let db;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function applyQueries(rows, url) {
  let out = rows;
  for (const raw of url.searchParams.getAll('queries[]')) {
    const q = JSON.parse(raw);
    if (q.method === 'equal') out = out.filter((r) => q.values.includes(r[q.attribute]));
    if (q.method === 'greaterThanEqual') {
      out = out.filter((r) => String(r[q.attribute] || '') >= q.values[0]);
    }
    if (q.method === 'limit') out = out.slice(0, q.values[0]);
    if (q.method === 'orderDesc') {
      const attr = q.attribute;
      out = [...out].sort((a, b) => String(b[attr] ?? '').localeCompare(String(a[attr] ?? '')));
    }
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
    if (!VALID_DOCUMENT_ID.test(documentId)) {
      return json(400, { message: `Invalid documentId: ${documentId}` });
    }
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

beforeEach(() => {
  db = { usage_events: new Map() };
});

test('document ids fit Appwrite rules', () => {
  const day = utcDay();
  assert.match(dailySlotId(TENANT, day, 0), VALID_DOCUMENT_ID);
  assert.match(dailySlotId(TENANT, day, 4), VALID_DOCUMENT_ID);
  assert.match(runLockId(TENANT), VALID_DOCUMENT_ID);
  assert.equal(dailySlotId(TENANT, day, 0).length <= 36, true);
  assert.equal(tenantKey(TENANT).length, 10);
});

test('the operator is uncapped; a member is not', () => {
  assert.deepEqual(decideScan({ operator: true, used: 99, running: 9 }), { ok: true });
  const daily = decideScan({ used: 5, running: 0, dailyLimit: 5 });
  assert.equal(daily.ok, false);
  assert.equal(daily.code, SCAN_DAILY);
  const busy = decideScan({ used: 0, running: 1, concurrency: 1 });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, SCAN_CONCURRENT);
});

test('five members racing for the last scan produce one winner', async () => {
  const day = utcDay();
  for (let n = 0; n < 4; n += 1) {
    db.usage_events.set(dailySlotId(TENANT, day, n), {
      $id: dailySlotId(TENANT, day, n),
      tenantId: TENANT,
      kind: 'search',
      outcome: 'ok',
    });
  }

  const results = await Promise.all(
    Array.from({ length: 5 }, () => reserveScan(member, TENANT).then(
      (r) => ({ ok: true, ...r }),
      (err) => ({ ok: false, err }),
    )),
  );
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  assert.equal(wins.length, 1, 'the fifth slot is a mutex, not a counter');
  assert.equal(losses.length, 4);
  assert.equal(losses[0].err.code, SCAN_DAILY);
  assert.equal(losses[0].err.status, 429);
});

test('a second running scan is refused without burning a daily slot', async () => {
  await acquireRunLock(TENANT);
  await assert.rejects(() => beginScan(member, TENANT), (err) => {
    assert.equal(err.code, SCAN_CONCURRENT);
    return true;
  });
  const day = utcDay();
  assert.equal(
    [...db.usage_events.keys()].filter((k) => k.startsWith(`sd.${tenantKey(TENANT)}.${day}.`)).length,
    0,
    'a concurrent 429 must not consume today\'s quota',
  );
});

test('a stale lock is stolen so a crashed worker cannot jam the account', async () => {
  const id = runLockId(TENANT);
  db.usage_events.set(id, {
    $id: id,
    tenantId: TENANT,
    kind: 'search',
    outcome: 'running',
    at: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
  });
  await acquireRunLock(TENANT);
  assert.equal(db.usage_events.get(id).outcome, 'running');
});

test('cancelling a queued reservation does not drop someone else\'s run lock', async () => {
  await acquireRunLock(TENANT);
  const { eventId } = await reserveScan(member, TENANT);
  await endScan(TENANT, eventId, { outcome: 'cancelled' }, { releaseLock: false });
  assert.equal(db.usage_events.get(eventId).outcome, 'cancelled');
  assert.equal(db.usage_events.has(runLockId(TENANT)), true, 'the running scan must keep its lock');
});

test('endScan records the outcome and drops the lock', async () => {
  const { eventId } = await beginScan(member, TENANT);
  await endScan(TENANT, eventId, { outcome: 'ok', durationMs: 1200 });
  assert.equal(db.usage_events.get(eventId).outcome, 'ok');
  assert.equal(db.usage_events.get(eventId).durationMs, 1200);
  assert.equal(db.usage_events.has(runLockId(TENANT)), false);
});

test('an unknown account cannot scan', async () => {
  await assert.rejects(
    () => reserveScan({ role: ROLE.MEMBER, plan: PLAN.FREE, status: 'unknown' }, TENANT),
    (err) => {
      assert.equal(err.code, SCAN_DENIED);
      assert.equal(err.status, 403);
      return true;
    },
  );
});

test('ScanQuotaError is what the HTTP layer keys off', () => {
  const err = new ScanQuotaError(SCAN_UNAVAILABLE, 'down', { status: 503 });
  assert.equal(err.name, 'ScanQuotaError');
  assert.equal(err.status, 503);
});

test('pipeline and scan draw on the same daily allowance', async () => {
  // The bypass this closes: `kind: "pipeline"` used to skip the reservation, and
  // with no OpenRouter key the worker's pipeline runs the SAME full scan.mjs.
  // Five reservations then one more must be refused, whatever the caller calls it.
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await reserveScan(member, TENANT);
    ids.push(r.eventId);
  }
  assert.equal(new Set(ids).size, 5, 'five distinct daily slots');

  await assert.rejects(
    () => reserveScan(member, TENANT),
    (err) => err.code === SCAN_DAILY,
    'the sixth request is refused whatever kind it calls itself',
  );
});

test('usageForTenant returns shape of usage, never content, newest first', async () => {
  db.usage_events.set('u1', {
    $id: 'u1',
    tenantId: TENANT,
    kind: 'search',
    outcome: 'ok',
    at: '2026-08-17T10:00:00.000Z',
    durationMs: 1200,
  });
  db.usage_events.set('u2', {
    $id: 'u2',
    tenantId: TENANT,
    kind: 'search',
    outcome: 'failed',
    at: '2026-08-17T12:00:00.000Z',
  });
  db.usage_events.set(runLockId(TENANT), {
    $id: runLockId(TENANT),
    tenantId: TENANT,
    kind: 'search',
    outcome: 'running',
    at: '2026-08-17T12:01:00.000Z',
  });
  db.usage_events.set('other', {
    $id: 'other',
    tenantId: 't_someoneelse',
    kind: 'search',
    outcome: 'ok',
    at: '2026-08-17T13:00:00.000Z',
  });

  const rows = await usageForTenant(TENANT);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['u2', 'u1'],
    'run locks and other tenants must not appear',
  );
  const serialized = JSON.stringify(rows);
  assert.ok(!/cv\.md/i.test(serialized));
  assert.ok(!/api[_-]?key/i.test(serialized));
});
