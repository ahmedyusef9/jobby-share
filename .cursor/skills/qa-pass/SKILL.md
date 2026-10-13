---
name: qa-pass
description: Run the BrowserMCP QA gate for a jobby feature — drive the UI per checklist, then record PASS/FAIL with scripts/qa-ship.mjs. Use when asked to "QA", "verify a feature", or "run the QA pass".
---

# QA pass — verify, then ship (BL-059)

One scripted session ships a verified feature. Never close an issue by hand;
always go through `scripts/qa-ship.mjs` so GitHub and the local trackers stay
in agreement.

## 1. Load what to test

Read `deploy/qa/R1-pass.md` and pick the section matching the feature under
test. Preconditions: compose stack up (`docker compose -f deploy/docker-compose.yml up --build -d`),
web on `http://127.0.0.1:<compose-web>` from `.ports.yml`, operator signed in. BrowserMCP must be connected
to the correct tab (see §2).

## 2. Drive the browser (`user-browsermcp` only)

Prefer the project **Playwright MCP extension** (`playwright` from `.cursor/mcp.json`);
use **`user-browsermcp`** when that extension has no product tab. Never Cursor’s
isolated browser (`cursor-ide-browser`) or Browserbase as a substitute, and never
curl HTML. Those do not share the tester’s Chrome session and are not a QA pass.

**Connection gate — first tool call is `browser_snapshot`.**

- If it errors **Not connected** / **No connection to browser extension**:
  **stop.** Do not fall back. Ask the user to open the **correct tab**, click
  the Browser MCP toolbar icon, then **Connect**, then confirm.
- After they confirm, snapshot again. If the URL is the wrong app or a login
  wall, ask them to switch the connected tab. Do not proceed until the
  snapshot shows the signed-in surface named in the QA prompt.

Then execute each step in the section exactly. A step passes only if the
observable result matches — never infer success from absence of errors alone.

## 3. Drive full user journeys (mandatory QA rule)

Never test tools or UI screens in isolation. Every QA pass must execute multi-turn, end-to-end user scenarios:

- **CV Journey**: Upload markdown → patch section → render PDF → verify signed download link logged-out
- **Scoring Journey**: Fetch jobs → select role → score with rationale & model provenance → verify tracker update → re-score (idempotency check)
- **Pipeline Journey**: Save discovered posting → move to inbox → promote to tracker → update status → verify ledger
- **Guards Journey**: Attempt over-budget call → verify rate limit → attempt write on read key → verify rejection

Isolated single-tool or single-page checks are NOT acceptable evidence. All assertions must verify observable state across turns.

## 4. Record the verdict

```bash
node scripts/qa-ship.mjs <issue#> pass --evidence "<what you saw + screenshot refs>"
node scripts/qa-ship.mjs <issue#> fail --note "<steps taken, expected vs actual, error text>"
```

- `pass` flips labels to status:done, closes the issue with evidence, sets the
  CSV/TSV rows to Done/closed.
- `fail` posts the failure evidence to the issue and keeps it open on
  status:in-progress. The feature branch stays unmerged.

## 4. Merge only on PASS

After a PASS, merge the feature branch into `release/v0.5.0` (if not already)
and commit any tracker changes:

```bash
git switch release/v0.5.0 && git merge --no-ff feat/<branch> && git push origin release/v0.5.0
```

Never merge on FAIL. Never touch main — that happens at release close.
