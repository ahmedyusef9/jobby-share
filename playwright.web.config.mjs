import { defineConfig } from 'playwright/test';

/**
 * Web-app e2e (R2). Targets the running compose stack by default —
 * override with JOBBY_E2E_BASE_URL. Unlike playwright.cv.config.mjs this
 * drives the real app, so it assumes http://<base> answers before the run.
 */
const BASE_URL = process.env.JOBBY_E2E_BASE_URL || 'http://localhost:4700';

export default defineConfig({
  testDir: './test/web-e2e',
  // Reclaims QA keys leaked by an interrupted run, once, before anything
  // mints. Per-spec cleanup cannot do this: mid-run, a spec cannot tell a
  // sibling's live fixture from last week's litter.
  globalSetup: './test/web-e2e/global-setup.mjs',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results/web-e2e-results',
  // Always emit run artifacts, not only on failure: qa-coverage.mjs reads the
  // JSON report to tell an executed test from a silently skipped one, and a
  // green run with 13 skips is exactly the case that report has to expose.
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/web-e2e-html', open: 'never' }],
    ['json', { outputFile: 'test-results/web-e2e-report.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    // QA rounds need to SHOW the run, not just score it. JOBBY_QA_EVIDENCE=1
    // records a trace for every test, pass or fail — a scrubable DOM timeline
    // (every click, the before/after DOM, network, console), which is what
    // actually proves a check happened. Open one with `npx playwright show-trace`.
    //
    // Video only covers tests that use the `page` fixture. Most of this suite
    // drives `request` or builds its own contexts with `browser.newPage()`,
    // which do not inherit recordVideo — those produce a trace and no video.
    // Off by default: always-on capture roughly doubles a run's wall time.
    trace: process.env.JOBBY_QA_EVIDENCE ? 'on' : 'retain-on-failure',
    video: process.env.JOBBY_QA_EVIDENCE ? 'on' : 'off',
  },
});
