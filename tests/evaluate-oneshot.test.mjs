// Operator Score remaps OpenCode → one openrouter-runner call (OmniRoute).
// Members must never receive that remap — D-010.
import { operatorEvaluateOneshot, operatorSandboxEnv } from '../deploy/worker/execute-run.mjs';
import { fail, pass } from './helpers.mjs';

console.log('\noperator evaluate oneshot remap');

const omni = {
  JOBBY_OMNIROUTE_BASE_URL: 'https://omni.example/v1/',
  JOBBY_OMNIROUTE_API_KEY: 'omni-secret',
  OPENCODE_MODEL: 'omniroute/auto/best-coding',
};

const op = operatorEvaluateOneshot('evaluate', 'opencode', { role: 'operator', status: 'active' }, omni);
(op?.engineCli === 'openrouter' ? pass : fail)('operator evaluate+opencode remaps to the runner');
(op?.model === 'auto/best-coding' ? pass : fail)('strips the OpenCode omniroute/ provider prefix');
(op?.env.OPENROUTER_API_URL === 'https://omni.example/v1/chat/completions' ? pass : fail)(
  'points the runner at OmniRoute chat completions',
);
(op?.env.OPENROUTER_TIMEOUT_MS === '120000' ? pass : fail)('gives the one call two minutes, not 15s');
(op?.env.OPENROUTER_API_KEY === 'omni-secret' ? pass : fail)('passes the operator OmniRoute key into the child');

const member = operatorEvaluateOneshot('evaluate', 'opencode', { role: 'member', status: 'active' }, omni);
(member === null ? pass : fail)('a member job is not remapped onto the operator key');

const pdf = operatorEvaluateOneshot('pdf', 'opencode', { role: 'operator', status: 'active' }, omni);
(pdf === null ? pass : fail)('PDF stays on OpenCode');

const already = operatorEvaluateOneshot('evaluate', 'openrouter', { role: 'operator', status: 'active' }, omni);
(already === null ? pass : fail)('a job already on the runner is left alone');

const noKey = operatorEvaluateOneshot(
  'evaluate',
  'opencode',
  { role: 'operator', status: 'active' },
  { JOBBY_OMNIROUTE_BASE_URL: 'https://omni.example/v1' },
);
(noKey === null ? pass : fail)('no remap without an OmniRoute key');

const host = operatorSandboxEnv({ role: 'operator', status: 'active' }, omni);
(host.JOBBY_OMNIROUTE_API_KEY === 'omni-secret' ? pass : fail)(
  'operator sandbox receives OmniRoute from the dispatcher',
);
const memberHost = operatorSandboxEnv({ role: 'member', status: 'active' }, omni);
(Object.keys(memberHost).length === 0 ? pass : fail)(
  'member sandbox does not inherit the dispatcher OmniRoute key',
);
