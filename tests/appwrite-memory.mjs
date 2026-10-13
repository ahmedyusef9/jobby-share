/**
 * In-memory Appwrite for node:test. Unique document ids 409, matching the
 * real server's mutex. A fake that is more permissive than Appwrite is how
 * the `#` slot-id bug shipped, so ids are validated here too.
 */
export const VALID_DOCUMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;

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
    if (q.method === 'orderDesc') {
      const attr = q.attribute;
      out = [...out].sort((a, b) => String(b[attr] ?? '').localeCompare(String(a[attr] ?? '')));
    }
    if (q.method === 'limit') out = out.slice(0, q.values[0]);
  }
  return out;
}

/**
 * Install a process-wide fetch fake. Call before importing modules that talk
 * to Appwrite. `reset()` empties every collection between tests.
 */
export function installAppwriteMemory() {
  process.env.APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://appwrite.test/v1';
  process.env.APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID || 'test';
  process.env.APPWRITE_API_KEY = process.env.APPWRITE_API_KEY || 'test';

  const state = { db: /** @type {Record<string, Map<string, Record<string, unknown>>>} */ ({}) };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const m = url.pathname.match(/\/collections\/([^/]+)\/documents(?:\/(.+))?$/);
    if (!m) return json(404, { message: 'no route' });

    const [, collection, rawId] = m;
    const id = rawId ? decodeURIComponent(rawId) : null;
    const store = (state.db[collection] ??= new Map());
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

  return {
    reset() {
      state.db = {};
    },
    collection(name) {
      return (state.db[name] ??= new Map());
    },
    get db() {
      return state.db;
    },
  };
}
