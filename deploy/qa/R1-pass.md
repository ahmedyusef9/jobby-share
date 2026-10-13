# R1 QA checklist — BrowserMCP pass

One section per feature. Execute with the browser against
`http://localhost:3001`, operator session. Record verdicts via
`node scripts/qa-ship.mjs <issue#> <pass|fail> --evidence|--note "…"`.

## #50 BL-054 — RBAC console v2

1. `/admin/rbac` renders a plan×capability matrix; structural rows (export,
   delete account, admin_*) are locked text "always"/"never" — no checkboxes.
2. Toggle one capability for plan `free` → **Publish changes** → success + new
   audit row `rbac.planCaps.set` with before→after.
3. `/admin`: change a member's Role to operator and back → succeeds; that
   account's live sessions are killed by design.
4. Member session: `/admin/rbac` returns 404 (not 403); no Access link in nav.

## #51 BL-055 — MCP resume toolkit (jobby MCP server, Connect key)

1. `resume_upload {content:"# Test CV\nSenior engineer"}` → ok, stored_as cv.md.
2. `resume_update {find:"Senior", replace_with:"Staff"}` → ok, bytes changed.
3. `get_resume` → content contains "Staff".
4. `resume_generate {}` → ok:true with pages + download_link URL.
5. Open the download link in a private window while logged out → PDF/md renders;
   response carries an expiry (expires_at ~15 min).

## #52 BL-056 — jobs_fetch

1. `jobs_fetch {}` → exactly ONE markdown table
   (Company|Role|Location|Posted|Status|Score|Posting|Jobby) + meta footer.
2. `jobs_fetch {source:"tracker", status:"Applied"}` → only Applied rows.
3. `jobs_fetch {from:"<today-7d>"}` → date filter narrows correctly.

## #53 BL-057 — submit_score

1. Pick a tracker row n from jobs_fetch →
   `submit_score {job_id:n, score:4.2, rationale:"strong fit", scored_by:"openai/gpt-5.2"}`
   → ok:true, updated:true.
2. Same call again → updated:false, idempotent:true.
3. `submit_score {score:9}` → rejected (out of range).
4. `/pipeline?tab=EVALUATED` shows 4.2/5 + `[scored-by: openai/gpt-5.2]` note.

## #54 BL-058 — zero-key member experience

1. Sign in as a MEMBER (non-operator account).
2. `/api/clis` (browser devtools or Config page) → empty engine list; Config
   shows the zero-key callout linking to /connect; NO paste-key card even after
   reload.
3. Trigger any AI action (Score / CV chat / apply autofill) → refusal message
   pointing at Account → MCP; no host call, no key prompt.
4. MCP tools (jobs_fetch, submit_score, resume_*) still work for the member —
   the zero-key rule blocks engines, not MCP.

## Ship rule

All four sections of a feature PASS → `qa-ship <issue#> pass` → merge branch to
release/v0.5.0. Any FAIL → fix first, re-run the section, never merge red.
