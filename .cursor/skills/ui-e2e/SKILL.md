---
name: ui-e2e
description: >-
  Automates jobby UI and API smoke tests: BrowserMCP sign-in (fill email and
  password), click every primary nav/button scenario, and OmniRoute/OpenCode
  API checks. Use when the user asks to UI-test, e2e, smoke-test the web app,
  verify buttons, or test via browsermcp / OpenCode / OmniRoute.
---

# Jobby UI + API e2e

Run against the live compose app. Do not invent extra docs. Report pass/fail per scenario.

## Credentials (never commit)

Read, in order:

1. `JOBBY_E2E_EMAIL` / `JOBBY_E2E_PASSWORD` / `JOBBY_E2E_BASE_URL`
2. `.career-ops-web/e2e.local.json` (`email`, `password`, `baseUrl`; optional `memberB: { email, password }` for isolation)

Never write the password into git, `SKILL.md`, chat logs as a “default”, or screenshots of the filled field if avoidable. Fill it in the live form; do not echo it back.

Default base URL: `http://localhost:3001`.

## Tools

| Layer | Server | Tools |
|---|---|---|
| UI (required) | `user-browsermcp` | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type` (`submit` required), `browser_select_option`, `browser_wait` |
| API / OpenCode path | `user-omniroute-advisor` | `omniroute_get_health`, `omniroute_list_models_catalog`, `omniroute_route_request` (role `coding`) |

**Connection gate:** first call `browser_snapshot`. On **Not connected** / **No connection to browser extension**, stop and ask the user to open the correct tab, click Browser MCP, then Connect. Do not fall back to Cursor’s built-in browser or `plugin-browse-browser` — those are a different cookie jar. Wrong URL after connect (login wall, other site) → ask them to switch the connected tab.

BrowserMCP has **no** `browser_fill`. Use `browser_type` with `submit: false` on Email and Password, then click **Sign in**.

Always snapshot after navigation before clicking. Refs go stale after each page change.

**Layout trap:** the signed-in shell duplicates the nav (mobile drawer + desktop `complementary`). Always click the complementary refs. Native `<select>` options: `browser_select_option` (empty string `""` = Any country). Clicking `<option>` WebSocket-timeouts.

**Pass bar:** a loaded URL is not enough. Filter, add-to-pipeline, health check, preview, insert-mark, and honest errors (no API key) are the contract. See [scenarios.md](scenarios.md).

Do not click **Submit** / **Apply** / **Send** on a real job posting. Discovery and form-fill are in scope; submitting an application is not.

## Sign-in (fill username and password)

1. `browser_navigate` `{baseUrl}/signin`
2. Snapshot. If **Sign in** tab exists, click it (not Create account).
3. `browser_type` Email, `submit: false`
4. `browser_type` Password, `submit: false`
5. Click the form **Sign in** button (not GitHub/Google/Operator).
6. Wait ~2s, snapshot. Pass = URL is not `/signin` and the sidebar shows **Today**.

Wrong password: stay on `/signin` with `role=alert`. Member must **not** see Operator (`/admin` → 404 page, not the console).

## Operator sign-in

Read `JOBBY_OPERATOR_SECRET` from `deploy/.env` (never copy the value into this skill, chat, or screenshots). On `/signin`:

1. Click **Operator sign-in** (collapsed when public signup is on)
2. `browser_type` the secret into **Operator secret**, `submit: false`
3. Click **Continue as operator**
4. Pass = sidebar account is not the member name; menu shows **Operator**; `/admin` loads capacity + accounts

Member pack first, then sign out, then this pack. If the complementary **Ahmad** / **Operator** button is missing from the snapshot (sidebar overflow under Worker pills), sign out via `{baseUrl}/api/auth/signout` then confirm **Sign out**.

**Stale session after suspend (L1):** `setAccountStatus` bumps `sessionVersion`, so the old cookie is dead. `/signin` must not bounce a dead JWT back to `/` (that is `ERR_TOO_MANY_REDIRECTS`). The sign-in page detects `sessionStillValid === false` and `signOut`s automatically. After L1, reload `/` — PASS is the sign-in form, not a redirect loop and not a manual cookie wipe.

**Screen catalog (RBAC writing):** [rbac.md](rbac.md) — every HTML URL, query string, overlay, complementary click, and show/hide. Click desktop `complementary` refs, never the mobile drawer duplicate. If a click times out, snapshot again and retry on a fresh ref. Do not switch to Cursor’s built-in browser.

## Product facts (do not invent UI)

- **Zero-key (BL-058 / D-029):** members never pick host CLIs and never paste an API key in Config. Config is a callout to Account → MCP (`/connect`). `GET /api/clis` → `{ clis: [], zeroKey: true }`. Scoring/CV intelligence runs in the member's own assistant. Operator Config still has the engine chooser + paste key. OmniRoute is compose env for in-container OpenCode — not a member Config field (D-010).
- **Upload resume:** first-run home, and `/cv` when `cv.md` is missing — paste or **Upload PDF / file**. `/cv` toolbar **Upload** is the photo, not the resume.
- **Explore sources:** Greenhouse, Lever, Ashby, Workday, Drushim, LinkedIn (D-019). LinkedIn is JobSpy, not a free ATS API. Role + location are **Refine search**. Israel in Explore = **Only in** chip, then **Re-cast**. Pipeline country default Israel is a different filter.
- **Workers:** one shared BullMQ queue; every job carries `tenantId`; ALS `runForJob`; files under `tenants/{id}/`; enqueue `jobId = runId` is idempotent.
- **Score fairness (D-023):** at most one running Score and one waiting Score per tenant. "Score all" keeps the rest in the browser list. UI must show `Queued (position #)` until the dispatcher starts the sandbox — never `Evaluating` while BullMQ state is waiting. ETA is serial for this account (do not divide by 3).
- **n8n (D-024):** optional later; signed Jobby HTTP API only. Never Redis, never the dispatcher.

## Run order

Copy the checklist in [scenarios.md](scenarios.md). Execute every row. Mark `PASS` / `FAIL` / `SKIP` with one evidence line (URL, visible text, or HTTP status).

Stop a scenario on the first failure; continue the rest. Close nothing the user still needs; leave the signed-in session if tests pass.

## API / OpenCode (OmniRoute on your-gateway-host)

OmniRoute **runs on the remote lab laptop** (`your-gateway` / your-gateway-host), not on this Mac. This machine’s OpenCode already points at it. Copy that config; do not start OmniRoute locally.

Source of truth: `~/.config/opencode/opencode.json`

- `provider.omniroute.options.baseURL` → `https://your-gateway.your-tailnet.ts.net:8443/v1`
- `model` → `omniroute/auto/best-coding` (OpenCode provider/model id)
- Same API key as Cursor `omniroute-advisor` Bearer (do not copy the key into this skill)

A03 OpenCode path (what the CLI actually sends):

```
POST {baseURL}/chat/completions
Authorization: Bearer <opencode apiKey>
model: auto/best-coding
```

Pass = reply contains `pong`. On the wire the model is `auto/best-coding`, not `omniroute/auto/best-coding` (that form 404s with `No active credentials for provider: omniroute`).

Cursor MCP (`/api/mcp/stream`) is a second client to the **same** host. If `omniroute_route_request` returns `Caller=anonymous`, that is Cursor not binding the Bearer — it is not “OmniRoute is on the wrong machine.” Confirm A03 with the `/v1` call above. `docker restart` on your-gateway-host does not reload `env_file`; recreate if you change `OMNIROUTE_MCP_SCOPES`.

## Report

For bounded runs, follow `sdlc-report`. Under VERIFIED EVIDENCE, one bullet per scenario id from [scenarios.md](scenarios.md).
