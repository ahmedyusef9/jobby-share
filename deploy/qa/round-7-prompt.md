# R2/R3 QA — Round 7 prompt (Real User Journeys · v0.5.1)

Target version: **v0.5.1** · Round: **7**

Paste this prompt into Cursor (`@deploy/qa/round-7-prompt.md`):

---

You are running the **Round 7 (v0.5.1) Real User Journeys QA Gate** for jobby.

## 1. Setup & Environment
- `git pull origin release/v0.5.1`
- `docker compose -f deploy/docker-compose.yml up --build -d` (rebuild web + worker)
- Confirm `http://localhost:3001` is live.

## 2. Automated Journeys Verification
Run the Playwright E2E suite locally:
```bash
npm run test:e2e
```
Expect **20 tests passed** (0 failed).

## 3. Manual BrowserMCP Journey Executions (`user-browsermcp` on `:3001`)

### Journey 1: Full CV Lifecycle (Member)
1. Call `resume_upload` (markdown) -> `resume_update` (patch text) -> `resume_generate` (PDF).
2. Open `download_link` in a private/incognito window (logged-out).
3. **PASS criteria**: PDF renders (HTTP 200), patched text visible, no auth error.

### Journey 2: End-to-End Scoring & Provenance (Member & Browser)
1. `jobs_fetch` -> pick a role -> `submit_score` with score 4.6 + `rationale` + `scored_by: "claude-3-5-sonnet"`.
2. Open `/pipeline?tab=EVALUATED` in browser.
3. **PASS criteria**: Row shows `4.6/5` AND `[scored-by: claude-3-5-sonnet · 4.6/5 · date]` prominently in the **Notes** column.
4. Re-submit identical score via MCP -> expect `idempotent: true`.

### Journey 3: Pipeline Progression (Member & Browser)
1. `save_jobs` -> convert to tracker via `add_application` (status: Applied) -> `update_application` (status: Interview).
2. **PASS criteria**: Status updates dynamically to `Interview` in `/pipeline` UI.

### Journey 4: Zero-Key Member Rules (Member)
1. Open `/config` as member -> zero-key callout only (no API key cards).
2. Check assistant console -> setup line points to `Account → MCP`.

## 4. Recording Verdicts & Commit
```bash
node scripts/qa-ship.mjs <issue#> pass --evidence "<journey evidence>"
```
Commit tracker updates:
```bash
git commit -am "chore(qa): v0.5.1 round 7 user journeys — shipped"
```
---
