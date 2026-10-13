# Debug prompt — RBAC panel dirty-state bug (#57 blocker, defect against #50)

Paste this into Cursor. Use browsermcp for the live repro, then fix the product code.

---

CONTEXT: repo jobby, branch `feat/bl-061-rbac-spec` (e2e spec exists:
`test/web-e2e/rbac.spec.mjs`). Stack is running at http://localhost:3001 —
I am signed in as OPERATOR in the browser you control.

BUG: In `/admin/rbac`, after one successful **Publish changes**, clicking the
SAME checkbox again flips it visually but the **Publish changes button stays
disabled** — as if the edit never registered. Clicking a *different* row's
checkbox right after works fine and enables Publish.

Repro that fails every time:
1. Open /admin/rbac (operator).
2. Row "Generate CV", column "free": click the checkbox (it toggles ON,
   Publish enables) → click **Publish changes** → success; an
   `rbac.planCaps.set` audit row appears; Publish goes disabled again.
3. Click the SAME checkbox once more → checkbox flips visually, but Publish
   stays DISABLED forever. Nothing is dirty.
4. Click any OTHER capability's checkbox → Publish enables immediately.

Evidence so far (Playwright debug runs):
- Pre-publish clicks always work; post-publish same-cell clicks never mark dirty.
- Suspected race: after Publish, the panel calls `load()` which refetches
  `/api/admin/rbac` and REBUILDS `draft` from the server response. My click
  lands mid-flight and the refetch's `setDraft(...)` overwrites it. Note
  "Publish goes disabled" only means `dirty === false` at that instant — it
  does NOT prove the refetch finished.

YOUR TASKS:

1. LIVE REPRO (browsermcp): walk steps 1–4 above. Confirm step 3 behavior,
   and watch DevTools Network: does `GET /api/admin/rbac` fire after Publish,
   and does it land BEFORE or AFTER my second click resolves?

2. ROOT CAUSE: read `web/src/components/rbac-panel.tsx` — specifically
   `load()`, `toggle()`, the `dirty` memo, and what happens right after
   `save()` succeeds (`await load()`). Confirm or refute: `load()`'s
   `setDraft(fromServer)` clobbers a user toggle made between publish-click
   and fetch-resolution.

3. FIX THE PRODUCT (not the spec): make post-publish state changes register.
   Direction (choose what fits the code): have `save()` await the refetch AND
   ignore/absorb stale draft rebuilds (e.g., functional setDraft guarded by a
   request id), or disable the grid while saving+refetching so no toggle can
   be swallowed. Do not weaken the spec to pass.

4. VERIFY:
   - Manual: repeat repro steps 1–4 — step 3 must now enable Publish.
   - Automated: `npx playwright test --config=playwright.web.config.mjs -g "L5 operator"`
     → all green, twice in a row.

5. RECORD (do not close #57):
   - Comment on issue **#50** describing the defect + fix commit (this is a
     defect found by BL-061's spec).
   - Comment on issue **#57** with the verification evidence.
   - Commit on the current branch:
     `fix(rbac): #50 dirty-state lost when toggling during post-publish refetch`

CONSTRAINTS: do not edit the spec's assertions; do not merge anything; do not
touch other files beyond the fix + this investigation.
