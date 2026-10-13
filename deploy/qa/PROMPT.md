# Standing QA-gate prompt — paste into Cursor, fill <ISSUE>

This file defines standing execution rules. Numbered manual gates live in
`deploy/qa/round-*-prompt.md`. Before creating one, enumerate those files and use
the next integer after the highest existing round; never overwrite or reuse a
round. Repeat that number in the heading, evidence, issue comments, and commit.
The agent derives live issue state from GitHub, not from this text.

---

You are running the BrowserMCP QA gate for jobby.

**Target:** issue(s) `<ISSUE>` (e.g. 54). Milestone context: run
`gh issue list -R ahmedyusef9/jobby -m "R1 — MCP-first platform (v0.5.0)" --state all`
and report where each target sits before starting.

**Setup (always, in order):**
1. `git pull origin release/v0.5.0` — report the new HEAD hash.
2. `docker compose -f deploy/docker-compose.yml up --build -d` — rebuild BOTH web and worker.
3. Wait until http://localhost:3001 responds.
4. Sign-in role: whatever the checklist section requires (operator default;
   member tests need the non-operator session).
5. Read `deploy/qa/R1-pass.md`; execute ONLY the sections matching your targets.

**Execution rules:**
- Drive every step with browsermcp exactly as written. A step passes only on
  the observable result stated there — absence of errors is not success.
- MCP tool tests use the Connect key of the account the section names.
- After suspend/reactivate (L1), `/` and `/signin` must settle on the sign-in
  form. `ERR_TOO_MANY_REDIRECTS` is a FAIL. Do not delete cookies to "fix" it —
  the product must drop the stale session automatically. The automated check is
  `test/web-e2e/multi-level-mcp.spec.mjs` L1.
- If a step fails, finish the remaining steps anyway (one full pass), then fail
  the issue once with all findings.

**Recording verdicts (never close issues by hand):**
- PASS → `node scripts/qa-ship.mjs <ISSUE#> pass --evidence "<what you verified>"`
- FAIL → `node scripts/qa-ship.mjs <ISSUE#> fail --note "<steps, expected vs actual>"`

**Wrap-up:**
- Print a table: # / verdict / evidence summary / new board state (re-run the
  `gh issue list` above).
- Commit tracker changes the script made:
  `chore(qa): <round or milestone> — <N>/<total> shipped`
- Do not edit code or unrelated files. Never merge anything on FAIL.
