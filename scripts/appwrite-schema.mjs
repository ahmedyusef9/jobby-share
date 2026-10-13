#!/usr/bin/env node
/**
 * Provision the Appwrite schema jobby needs (JOBBY-BL-041).
 *
 * Idempotent: every create tolerates "already exists", so re-running after adding
 * an attribute is safe and is the intended way to evolve the schema.
 *
 *   APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… APPWRITE_API_KEY=… node scripts/appwrite-schema.mjs
 *
 * What lives here vs on disk
 * --------------------------
 * Appwrite holds the *structured* tenant record: who they are, their plan, their
 * preferences, and their encrypted provider keys. That is the "single place" for
 * tenants, keys and configs.
 *
 * The tenant's working files (cv.md, reports/, data/) stay on disk, because the
 * spawned CLI agents need a real directory to read and write — no object store
 * can be `cd`-ed into.
 *
 * Keys are stored ALREADY ENCRYPTED under the master KEK. Appwrite is a database,
 * and anyone with console access can read a document; encryption is what stops an
 * Appwrite admin from reading a tenant's provider key.
 */
const ENDPOINT = process.env.APPWRITE_ENDPOINT?.replace(/\/$/, '');
const PROJECT = process.env.APPWRITE_PROJECT_ID;
const KEY = process.env.APPWRITE_API_KEY;

if (!ENDPOINT || !PROJECT || !KEY) {
  console.error('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY');
  process.exit(1);
}

export const DB_ID = 'jobby';
export const COL_TENANTS = 'tenants';
export const COL_IDENTITIES = 'identities';
export const COL_KEYS = 'provider_keys';
export const COL_USAGE = 'usage_events';
export const COL_CONFIG = 'app_config';
export const COL_BATCHES = 'batches';
export const COL_SLOTS = 'capacity_slots';
export const COL_JOB_EVENTS = 'job_events';
export const COL_MCP = 'mcp_tokens';

async function call(method, path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Appwrite-Project': PROJECT,
      'X-Appwrite-Key': KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** Treat "already exists" as success so the script can be re-run. */
async function ensure(label, method, path, body) {
  const r = await call(method, path, body);
  if (r.ok) {
    console.log(`  created  ${label}`);
    return true;
  }
  if (r.status === 409) {
    console.log(`  exists   ${label}`);
    return true;
  }
  // Appwrite answers 400, not 409, for a duplicate index. Without this the script
  // reports failures on every re-run, which would train us to ignore its output.
  if (r.status === 400 && /already an index/i.test(r.body?.message ?? '')) {
    console.log(`  exists   ${label}`);
    return true;
  }
  console.error(`  FAILED   ${label}: ${r.status} ${JSON.stringify(r.body)}`);
  return false;
}

const str = (col, key, size, required = false, array = false) =>
  ensure(`${col}.${key}`, 'POST', `/databases/${DB_ID}/collections/${col}/attributes/string`, {
    key,
    size,
    required,
    array,
  });

const int = (col, key, required = false) =>
  ensure(`${col}.${key}`, 'POST', `/databases/${DB_ID}/collections/${col}/attributes/integer`, {
    key,
    required,
  });

const dt = (col, key, required = false) =>
  ensure(`${col}.${key}`, 'POST', `/databases/${DB_ID}/collections/${col}/attributes/datetime`, {
    key,
    required,
  });

const index = (col, key, type, attributes) =>
  ensure(`${col}#${key}`, 'POST', `/databases/${DB_ID}/collections/${col}/indexes`, {
    key,
    type,
    attributes,
  });

/**
 * Collections carry no client permissions on purpose.
 *
 * Every read and write goes through the jobby server with the API key, after the
 * server has resolved the tenant from a verified session. A browser holding an
 * Appwrite session must never be able to query the tenants collection directly —
 * that would let any signed-in user enumerate every other account.
 */
const collection = (id, name) =>
  ensure(`collection ${id}`, 'POST', `/databases/${DB_ID}/collections`, {
    collectionId: id,
    name,
    permissions: [],
    documentSecurity: false,
  });

/**
 * Turn on email/password sign-in for the project.
 *
 * A new Appwrite project has this OFF, and the failure it produces is the nastiest
 * kind: registration succeeds — `users.create` is an admin call that ignores the
 * setting — and then every sign-in fails with a generic "credentials" error. The
 * account exists, the password is right, and nothing says why. Enabling it here
 * means a fresh project cannot be provisioned into that state.
 */
async function enableEmailPassword() {
  const r = await call('PATCH', `/projects/${PROJECT}/auth/email-password`, { enabled: true });
  if (r.ok) {
    console.log('  enabled  email/password sign-in');
    return;
  }
  // A project-scoped key may not carry `projects.write`; say what to click.
  console.error(
    `  MANUAL   could not enable email/password (${r.status}). ` +
      'Turn it on in the console: Auth → Settings → Email/Password.',
  );
}

async function main() {
  console.log(`Appwrite ${ENDPOINT} · project ${PROJECT}\n`);

  console.log('auth methods');
  await enableEmailPassword();

  console.log('\ndatabase');
  if (!(await ensure('database jobby', 'POST', '/databases', { databaseId: DB_ID, name: 'jobby' }))) {
    process.exit(1);
  }

  console.log('\ncollection: tenants — one row per account');
  await collection(COL_TENANTS, 'Tenants');
  await str(COL_TENANTS, 'userId', 64, true); // Appwrite user $id
  await str(COL_TENANTS, 'tenantId', 64, true); // on-disk directory name
  await str(COL_TENANTS, 'email', 320);
  await str(COL_TENANTS, 'role', 32, true); // operator | member
  await str(COL_TENANTS, 'plan', 32, true); // operator | member plans: alpha | free | basic | plus | advanced
  await str(COL_TENANTS, 'status', 32, true); // active | suspended | deleting
  await str(COL_TENANTS, 'cohort', 64);
  await dt(COL_TENANTS, 'createdAt');
  await dt(COL_TENANTS, 'lastSeenAt');
  await dt(COL_TENANTS, 'deletedAt');
  await int(COL_TENANTS, 'sessionVersion');
  // Preferences and configs as a JSON blob: they are read whole, never queried by
  // field, so a column per setting would be schema churn for no gain.
  await str(COL_TENANTS, 'prefs', 16384);
  await index(COL_TENANTS, 'idx_userId', 'unique', ['userId']);
  await index(COL_TENANTS, 'idx_tenantId', 'unique', ['tenantId']);
  await index(COL_TENANTS, 'idx_email', 'key', ['email']);

  console.log('\ncollection: identities — login → account mutex (D-008)');
  await collection(COL_IDENTITIES, 'Identities');
  // Document id is a hash of provider:subject. Creating it is the mutex that
  // stops two first-login tabs from forking one person into two tenants.
  await str(COL_IDENTITIES, 'identityKey', 256, true); // provider:subject
  await str(COL_IDENTITIES, 'provider', 32, true);
  await str(COL_IDENTITIES, 'subject', 256, true);
  await str(COL_IDENTITIES, 'accountId', 64, true);
  await str(COL_IDENTITIES, 'email', 320);
  await index(COL_IDENTITIES, 'idx_identityKey', 'unique', ['identityKey']);
  await index(COL_IDENTITIES, 'idx_accountId', 'key', ['accountId']);
  await index(COL_IDENTITIES, 'idx_email', 'key', ['email']);

  console.log('\ncollection: provider_keys — encrypted, never plaintext');
  await collection(COL_KEYS, 'Provider keys');
  await str(COL_KEYS, 'tenantId', 64, true);
  await str(COL_KEYS, 'provider', 32, true); // openrouter | openai | anthropic | gemini
  await str(COL_KEYS, 'ct', 4096, true); // ciphertext
  await str(COL_KEYS, 'iv', 64, true);
  await str(COL_KEYS, 'tag', 64, true);
  await str(COL_KEYS, 'dek', 1024, true); // wrapped data key
  await str(COL_KEYS, 'last4', 8);
  await int(COL_KEYS, 'keyVersion');
  await dt(COL_KEYS, 'createdAt');
  await dt(COL_KEYS, 'updatedAt');
  await dt(COL_KEYS, 'lastUsedAt');
  await index(COL_KEYS, 'idx_tenant_provider', 'unique', ['tenantId', 'provider']);

  console.log('\ncollection: usage_events — shape of usage, never its content');
  await collection(COL_USAGE, 'Usage events');
  await str(COL_USAGE, 'tenantId', 64, true);
  await str(COL_USAGE, 'kind', 32, true); // search | score | pdf | cv_save | cv_chat | signup
  await str(COL_USAGE, 'engine', 64);
  await str(COL_USAGE, 'outcome', 32); // ok | failed | cancelled
  await str(COL_USAGE, 'errorClass', 128);
  await int(COL_USAGE, 'durationMs');
  await int(COL_USAGE, 'tokens');
  await str(COL_USAGE, 'costUsd', 32); // string: exact decimal, no float drift on money
  await dt(COL_USAGE, 'at');
  await index(COL_USAGE, 'idx_tenant_at', 'key', ['tenantId', 'at']);

  console.log('\ncollection: app_config — versioned, immutable application config');
  await collection(COL_CONFIG, 'App config');
  await str(COL_CONFIG, 'version', 32, true); // semver-ish, e.g. 1.0.0
  await str(COL_CONFIG, 'state', 16, true); // draft | active | retired
  // The config itself as JSON. A row is never edited after activation — a change
  // means a NEW version, so what a release ran with stays readable forever.
  await str(COL_CONFIG, 'config', 32768, true);
  await str(COL_CONFIG, 'notes', 1024);
  await dt(COL_CONFIG, 'createdAt');
  await dt(COL_CONFIG, 'activatedAt');
  await dt(COL_CONFIG, 'retiredAt');
  await index(COL_CONFIG, 'idx_version', 'unique', ['version']);
  await index(COL_CONFIG, 'idx_state', 'key', ['state']);

  console.log('\ncollection: batches — one signup cohort per release');
  await collection(COL_BATCHES, 'Batches');
  await str(COL_BATCHES, 'batchId', 64, true); // e.g. alpha-1
  await str(COL_BATCHES, 'appVersion', 32, true); // which release this batch tests
  await str(COL_BATCHES, 'configVersion', 32); // app_config version in force
  await str(COL_BATCHES, 'state', 16, true); // draft | open | full | closed | archived
  await str(COL_BATCHES, 'plan', 32, true); // plan every account in this batch gets
  await int(COL_BATCHES, 'capacity'); // the live limit; raise it to admit more people
  await str(COL_BATCHES, 'notes', 1024);
  await dt(COL_BATCHES, 'createdAt');
  await dt(COL_BATCHES, 'openedAt');
  await dt(COL_BATCHES, 'closedAt');
  await index(COL_BATCHES, 'idx_batchId', 'unique', ['batchId']);
  await index(COL_BATCHES, 'idx_state', 'key', ['state']);

  console.log('\ncollection: capacity_slots — one row per account admitted');
  await collection(COL_SLOTS, 'Capacity slots');
  // The document id is `{batchId}_{index}`. Appwrite guarantees ids are unique, so
  // creating one either succeeds or returns 409 — that is a real mutex, and it is
  // what stops two people taking the last place. Comparing a counter with capacity
  // would not serialise anything: both racers read the same number before writing.
  //
  // Registration is open — there is no invite row, because nobody is on a list.
  await str(COL_SLOTS, 'batchId', 64, true);
  await int(COL_SLOTS, 'slotIndex');
  await str(COL_SLOTS, 'claimedBy', 64, true); // accountId, or `pending:{email}` mid-signup
  await dt(COL_SLOTS, 'claimedAt');
  await index(COL_SLOTS, 'idx_batch', 'key', ['batchId']);
  await index(COL_SLOTS, 'idx_claimedBy', 'key', ['claimedBy']);

  console.log('\ncollection: job_events — run state, never run content');
  await collection(COL_JOB_EVENTS, 'Job events');
  await str(COL_JOB_EVENTS, 'jobId', 64, true);
  await str(COL_JOB_EVENTS, 'tenantId', 64, true);
  await str(COL_JOB_EVENTS, 'traceId', 64);
  await str(COL_JOB_EVENTS, 'kind', 32, true);
  await str(COL_JOB_EVENTS, 'engine', 64);
  await str(COL_JOB_EVENTS, 'workerId', 64);
  await str(COL_JOB_EVENTS, 'state', 32, true); // queued | running | validated | succeeded | failed | incomplete | cancelled | timed_out
  await str(COL_JOB_EVENTS, 'fromState', 32);
  await str(COL_JOB_EVENTS, 'artifactClass', 64);
  await str(COL_JOB_EVENTS, 'errorClass', 128);
  await int(COL_JOB_EVENTS, 'durationMs');
  await int(COL_JOB_EVENTS, 'tokens');
  await str(COL_JOB_EVENTS, 'costUsd', 32);
  await dt(COL_JOB_EVENTS, 'at');
  await index(COL_JOB_EVENTS, 'idx_tenant_at', 'key', ['tenantId', 'at']);
  await index(COL_JOB_EVENTS, 'idx_jobId', 'key', ['jobId']);

  console.log('\ncollection: mcp_tokens — hashed MCP API keys (D-030)');
  await collection(COL_MCP, 'MCP tokens');
  await str(COL_MCP, 'tenantId', 64, true);
  await str(COL_MCP, 'name', 32);
  await str(COL_MCP, 'prefix', 16);
  await str(COL_MCP, 'scope', 12); // read | read-write (BL-075); absent = legacy full access
  await dt(COL_MCP, 'expiresAt'); // absent = never expires (legacy/back-compat)
  await dt(COL_MCP, 'createdAt');
  await dt(COL_MCP, 'lastUsedAt');
  await index(COL_MCP, 'idx_tenantId', 'key', ['tenantId']);

  console.log('\nDone. Attributes build asynchronously — re-run to confirm all are available.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
