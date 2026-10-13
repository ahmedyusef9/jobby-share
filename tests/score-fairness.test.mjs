import {
  decideScoreAdmission,
  SCORE_MAX_ACTIVE,
  SCORE_MAX_WAITING,
  workerConcurrency,
  tryAcquireScoreRunLock,
  releaseScoreRunLock,
  scoreRunLockKey,
} from '../scripts/score-fairness.mjs';
import { fail, pass } from './helpers.mjs';

console.log('\nscore fairness (D-023)');

const ok = (c) => decideScoreAdmission(c).ok === true;
const no = (c) => decideScoreAdmission(c).ok === false;

(ok({ active: 0, waiting: 0 }) ? pass : fail)('empty tenant can enqueue');
(ok({ active: 1, waiting: 0 }) ? pass : fail)('one running Score may take one waiter');
(no({ active: 0, waiting: 1 }) ? pass : fail)('a waiter already filling the slot blocks Score all');
(no({ active: 1, waiting: 1 }) ? pass : fail)('one running + one waiting is the ceiling');
(no({ active: 2, waiting: 0 }) ? pass : fail)('two running is over the cap');
(decideScoreAdmission({ active: 0, waiting: 1 }).code === 'SCORE_FAIRNESS' ? pass : fail)(
  'rejection is SCORE_FAIRNESS, not a silent drop',
);
(SCORE_MAX_ACTIVE === 1 && SCORE_MAX_WAITING === 1 ? pass : fail)('cap is 1 running and 1 waiting');
(workerConcurrency({ JOBBY_WORKER_CONCURRENCY: '3' }) === 3 ? pass : fail)('reads JOBBY_WORKER_CONCURRENCY');
(workerConcurrency({}) === 1 ? pass : fail)('defaults to 1 sandbox at a time');
(workerConcurrency({ JOBBY_WORKER_CONCURRENCY: '0' }) === 1 ? pass : fail)('zero is not a concurrency');

function memRedis() {
  const store = new Map();
  return {
    store,
    async set(key, val, _ex, _ttl, nx) {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, String(val));
      return 'OK';
    },
    async eval(_script, _n, key, argv) {
      if (store.get(key) === String(argv)) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  };
}
const redis = memRedis();
(await tryAcquireScoreRunLock(redis, 't1', 'job-a') ? pass : fail)('first Score takes the run lock');
(!(await tryAcquireScoreRunLock(redis, 't1', 'job-b')) ? pass : fail)('second Score for the same tenant is delayed');
(await tryAcquireScoreRunLock(redis, 't2', 'job-c') ? pass : fail)('a different tenant can still run');
await releaseScoreRunLock(redis, 't1', 'job-a');
(await tryAcquireScoreRunLock(redis, 't1', 'job-b') ? pass : fail)('lock frees when the running Score finishes');
(scoreRunLockKey('t1') === 'jobby:score-run:t1' ? pass : fail)('run lock key is per tenant');
