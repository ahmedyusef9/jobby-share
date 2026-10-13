/**
 * Minimal Appwrite document access over REST (JOBBY-BL-044).
 *
 * Lives in scripts/ because the same modules are imported by the Next server and
 * by the worker, and scripts/ has no package.json of its own — a fetch client with
 * no dependencies is the only thing that works in both without duplicating code.
 *
 * Server-side only: it carries the API key.
 */

const DB_ID = 'jobby';

function config(env = process.env) {
  const endpoint = env.APPWRITE_ENDPOINT?.trim().replace(/\/$/, '');
  const project = env.APPWRITE_PROJECT_ID?.trim();
  const key = env.APPWRITE_API_KEY?.trim();
  return { endpoint, project, key, ready: Boolean(endpoint && project && key) };
}

export function appwriteConfigured(env = process.env) {
  return config(env).ready;
}

/** Hung / refused / timed-out Appwrite — callers must fail soft, not 500. */
export function isAppwriteUnavailable(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403 || err.status >= 500) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.code || err.cause?.code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return true;
  }
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** @param {string} path @param {RequestInit} [init] */
async function call(path, init = {}) {
  const { endpoint, project, key, ready } = config();
  if (!ready) throw new Error('Appwrite is not configured');

  const timeoutMs = Number(process.env.CAREER_OPS_APPWRITE_TIMEOUT_MS || 8000);
  const res = await fetch(`${endpoint}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'X-Appwrite-Project': project,
      'X-Appwrite-Key': key,
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!res.ok) {
    const err = new Error(body?.message || `Appwrite ${res.status}`);
    err.status = res.status;
    err.type = body?.type;
    throw err;
  }
  return body;
}

const col = (name) => `/databases/${DB_ID}/collections/${name}`;

/**
 * List documents. `queries` uses Appwrite's query string form, e.g.
 * `equal("state", ["open"])`.
 *
 * @param {string} collection
 * @param {string[]} [queries]
 */
export async function listDocuments(collection, queries = []) {
  const params = new URLSearchParams();
  for (const q of queries) params.append('queries[]', q);
  const qs = params.toString();
  const body = await call(`${col(collection)}/documents${qs ? `?${qs}` : ''}`);
  return body.documents ?? [];
}

/** @param {string} collection @param {string} id */
export async function getDocument(collection, id) {
  try {
    return await call(`${col(collection)}/documents/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** @param {string} collection @param {string} id @param {Record<string, unknown>} data */
export async function createDocument(collection, id, data) {
  return call(`${col(collection)}/documents`, {
    method: 'POST',
    body: JSON.stringify({ documentId: id, data }),
  });
}

/** @param {string} collection @param {string} id @param {Record<string, unknown>} data */
export async function updateDocument(collection, id, data) {
  return call(`${col(collection)}/documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ data }),
  });
}

/** @param {string} collection @param {string} id */
export async function deleteDocument(collection, id) {
  try {
    await call(`${col(collection)}/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Query builders.
 *
 * Appwrite takes JSON-encoded queries. The older string form —
 * `equal("state", ["active"])` — is pre-1.5 and this server (1.9.6) rejects it
 * with "Invalid query: Syntax error", which is what caught me out.
 */
export const Q = {
  equal: (attribute, values) => JSON.stringify({ method: 'equal', attribute, values }),
  greaterThanEqual: (attribute, values) =>
    JSON.stringify({ method: 'greaterThanEqual', attribute, values }),
  limit: (n) => JSON.stringify({ method: 'limit', values: [n] }),
  orderDesc: (attribute) => JSON.stringify({ method: 'orderDesc', attribute }),
};
