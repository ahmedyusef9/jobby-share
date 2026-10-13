/** Shared real-login flows for web e2e specs (BL-060 credentials contract). */
import { memberCredentials, operatorCredentials } from './credentials.mjs';

/**
 * Fill a credential form and submit it, tolerating a fill that lands before
 * React has hydrated.
 *
 * The sign-in submit is `disabled={busy || !email || !password}`
 * (web/src/app/signin/signin-form.tsx:243) and the operator submit is
 * `disabled={busy || !secret}` (:347) — both driven by React state, not by the
 * DOM. `page.goto('/signin')` returns before hydration finishes, so a fill that
 * wins that race sets the input's DOM value and never reaches React: state
 * stays empty, the button stays disabled, and nothing ever re-enables it.
 * `click()` then waits out the ENTIRE test timeout retrying "element is not
 * enabled" — 352 retries over 180s in the round-10 failure, whose trace shows
 * the input holding `__playwright_value_: "Qaz@2206"` while React still
 * rendered `value=""`.
 *
 * It is a race, so it only bites when hydration is slow — late in a long suite
 * on a loaded machine — which is exactly why it read as an intermittent
 * access-control defect for three rounds and was not one.
 *
 * Re-filling until the button enables is what makes it deterministic: after
 * hydration the same fill dispatches an input event React actually receives.
 * Filling a field that already holds the value is a no-op, so this is safe to
 * repeat.
 *
 * Deliberately free of `playwright/test` imports so global-setup.mjs and
 * bootstrap-mcp-key.mjs — neither of which runs inside the test runner — can
 * use the same primitive instead of keeping their own racy copy.
 *
 * @param {import('playwright').Page} page
 * @param {Array<[import('playwright').Locator, string]>} fields locator/value pairs
 * @param {import('playwright').Locator} submit
 */
/**
 * A React root attaches `__react*` fiber keys to its DOM nodes only after
 * hydration. A controlled input that is not yet hydrated discards any DOM-set
 * value on first render, so waiting on this before filling makes the fill
 * deterministic instead of racing hydration.
 */
function isHydrated(el) {
  return Object.keys(el).some((k) => k.startsWith('__react'));
}

export async function fillAndSubmit(page, fields, submit, { timeout = 20_000 } = {}) {
  // A React root that threw stops processing updates while still LOOKING
  // hydrated, so the page's own errors are the difference between "the fill
  // raced hydration" and "this page's JS is broken". Captured only for the
  // failure message; listeners are removed on the way out.
  const noise = [];
  const onError = (err) => noise.push(`pageerror: ${String(err).split('\n')[0]}`);
  const onConsole = (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') noise.push(`${msg.type()}: ${msg.text().slice(0, 200)}`);
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  const deadline = Date.now() + timeout;
  for (;;) {
    // Fill only once the submit button is actually hydrated: filling an
    // un-hydrated controlled input is a throwaway (React wipes the DOM value
    // on first render), and on a busy stack that wipe can keep chasing every
    // re-fill. Waiting for hydration first turns the race into a no-op.
    const hydrated = await submit.evaluate(isHydrated).catch(() => false);
    if (hydrated) {
      for (const [locator, value] of fields) {
        await locator.fill(value);
        // Confirm the value actually reached React state (the thing the submit's
        // disabled flag reads); re-fill the field alone if a re-render dropped it.
        const received = await locator.evaluate((el) => {
          const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactProps'));
          return fiberKey ? el[fiberKey].value : undefined;
        });
        if (received !== value) await locator.fill(value);
      }
    }
    if (await submit.isEnabled().catch(() => false)) break;
    if (Date.now() >= deadline) {
      // Say WHY it never enabled. `disabled={busy || !email || !password}` has
      // three causes and they need different fixes: aria-busy means a submit is
      // already in flight, an un-hydrated button means React never attached and
      // no fill will ever reach state, and a hydrated button with filled inputs
      // means the value is not the one bound to state.
      const diag = await submit
        .evaluate((el) => ({
          disabled: el.disabled,
          ariaBusy: el.getAttribute('aria-busy'),
          hydrated: Object.keys(el).some((k) => k.startsWith('__react')),
          inputs: [...el.form.querySelectorAll('input')].map((i) => {
            const fiberKey = Object.keys(i).find((k) => k.startsWith('__reactProps'));
            const reactValue = fiberKey ? i[fiberKey].value : '<no fiber>';
            return `${i.type}: dom=${i.value ? 'set' : 'EMPTY'} react=${reactValue ? 'set' : 'EMPTY'}`;
          }),
        }))
        .catch((err) => ({ probeFailed: err.message.split('\n')[0] }));
      page.off('pageerror', onError);
      page.off('console', onConsole);
      throw new Error(
        `submit never enabled within ${timeout}ms at ${page.url()} — ${JSON.stringify(diag)}\n` +
          `page said: ${noise.length ? noise.slice(0, 6).join(' :: ') : '(nothing)'}\n` +
          'see fillAndSubmit in test/web-e2e/auth.helpers.mjs',
      );
    }
    await page.waitForTimeout(250);
  }
  page.off('pageerror', onError);
  page.off('console', onConsole);
  await submit.click();
}

export async function loginMember(page) {
  const m = memberCredentials();
  if (!m) throw new Error('member creds missing');
  await page.goto('/signin');
  await fillAndSubmit(
    page,
    [
      [page.getByLabel('Email'), m.email],
      [page.getByLabel('Password'), m.password],
    ],
    page.getByRole('button', { name: 'Sign in', exact: true }),
  );
  await page.waitForURL((u) => !String(u).includes('/signin'), { timeout: 15_000 });
}

export async function loginOperator(page) {
  const o = operatorCredentials();
  if (!o) throw new Error('operator secret missing');
  await page.goto('/signin');
  const reveal = page.getByRole('button', { name: 'Operator sign-in' });
  if (await reveal.isVisible().catch(() => false)) await reveal.click();
  await fillAndSubmit(
    page,
    [[page.getByLabel('Operator secret'), o.secret]],
    page.getByRole('button', { name: 'Continue as operator' }),
  );
  await page.waitForURL((u) => !String(u).includes('/signin'), { timeout: 15_000 });
}
