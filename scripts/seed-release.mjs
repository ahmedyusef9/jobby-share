#!/usr/bin/env node
/**
 * Seed a release: publish a config version and open a batch with a capacity
 * (JOBBY-BL-044, BL-046).
 *
 * Idempotent and replayable — it is the definition of a testing round, so it must
 * survive being run twice and must be re-runnable after a schema rebuild.
 *
 *   APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… APPWRITE_API_KEY=… \
 *     node scripts/seed-release.mjs --batch alpha-1 --capacity 10 --version 0.4.0 --open
 *
 * Registration is open: anybody may create an account while the batch is open and
 * under capacity. There are no invites to mint and no addresses to list. Raising
 * the limit later is `--capacity 15` on a re-run, or the operator screen.
 */
import { BATCH_STATE } from './release-state.mjs';
import { publishConfigVersion } from './config-store.mjs';
import { createBatch, setBatchState, setCapacity, slotsFor } from './batch-store.mjs';
import { appwriteConfigured, getDocument } from './appwrite-rest.mjs';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

async function main() {
  if (!appwriteConfigured()) {
    console.error('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY');
    process.exit(1);
  }

  const batchId = String(arg('batch', 'alpha-1'));
  const capacity = Number(arg('capacity', 10));
  const appVersion = String(arg('version', '0.4.0'));
  const configVersion = String(arg('config-version', '1.0.0'));
  const plan = String(arg('plan', 'alpha'));

  console.log(`batch ${batchId} · capacity ${capacity} · app ${appVersion} · plan ${plan}\n`);

  // 1. Config version. Publishing is safe to skip if this version already exists.
  const existingConfig = await getDocument('app_config', configVersion);
  if (existingConfig) {
    console.log(`config    ${configVersion} exists (${existingConfig.state})`);
  } else {
    const r = await publishConfigVersion(
      configVersion,
      {
        defaultPlan: plan,
        signupOpen: true,
        maxAccounts: capacity,
        sessionMaxAgeDays: 7,
        deletionGraceDays: 7,
        requireOwnApiKey: true,
        feedbackUrl: String(arg('feedback-url', '')),
      },
      `Seeded with ${batchId}`,
    );
    if (!r.ok) {
      console.error('config invalid:', r.errors.join('; '));
      process.exit(1);
    }
    console.log(`config    ${configVersion} published and active`);
  }

  // 2. Batch. On a re-run this is where a changed --capacity takes effect, which
  //    is the supported way to admit more people without touching code.
  let batch = await getDocument('batches', batchId);
  if (batch) {
    console.log(`batch     ${batchId} exists (${batch.state}, capacity ${batch.capacity})`);
    if (Number(batch.capacity) !== capacity) {
      const r = await setCapacity(batchId, capacity);
      console.log(
        r.ok
          ? `capacity  ${batch.capacity} → ${capacity} (${r.taken} taken, ${r.remaining} free)`
          : `capacity  not changed: ${r.error}`,
      );
    }
  } else {
    batch = await createBatch({ batchId, appVersion, capacity, plan, configVersion });
    console.log(`batch     ${batchId} created (draft)`);
  }

  // 3. Open it, if asked.
  if (arg('open')) {
    const r = await setBatchState(batchId, BATCH_STATE.OPEN);
    console.log(r.ok ? `batch     ${batchId} is now OPEN` : `batch     not opened: ${r.error}`);
  } else {
    console.log(`\nbatch is in draft — open it with:  node scripts/seed-release.mjs --batch ${batchId} --open`);
  }

  const taken = (await slotsFor(batchId)).length;
  console.log(`\naccounts: ${taken} of ${capacity} · ${Math.max(0, capacity - taken)} places free`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
