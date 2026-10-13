# R1 QA — Round 6 prompt (#54 re-run after assistant fix)

Use the standing prompt: `deploy/qa/PROMPT.md` with `<ISSUE>` = 54.

Fix under test: `a80f013` — assistant-console now fetches `/api/clis` on mount
(no early return on `!cliId`), so `zeroKey` resolves for members; setup link →
`/connect`; header + placeholder show MCP wording.

Preconditions:
- git pull origin release/v0.5.0
- docker compose -f deploy/docker-compose.yml up --build -d   (rebuild BOTH images)
- Member session: ahmed@jobby.local.v1 (t_<tenant>)

## Checks

### A. Assistant (the blocker — all four surfaces)
As member, open the assistant console:
1. Setup line reads: "Scoring runs in your own assistant — connect under
   Account → MCP →" and the link goes to **/connect** (not /config).
2. Header subline reads "connect via Account → MCP" (not "no CLI configured").
3. Input placeholder reads "Score in your own assistant — see Account → MCP".
4. Devtools: GET /api/clis fires on console open and returns
   { clis: [], zeroKey: true }.

### B. Regression sweep (fast — these passed in round 5)
5. Inbox Score link/tooltips still point at Account → MCP.
6. /pipeline/open CTA still "Score via Account → MCP".
7. /config still shows the zero-key callout only; /api/clis → { clis: [] }.

### C. Operator untouched
8. Operator session: /config still shows engine chooser + paste key;
   assistant header shows "via <cliId>" when one is selected; no MCP pointer.

## Recording verdicts (terminal)

    node scripts/qa-ship.mjs 54 pass --evidence "<what you verified>"
    node scripts/qa-ship.mjs 54 fail --note "<steps, expected vs actual>"

On PASS: milestone R1 is complete (6/6). Report the final board table and
commit tracker changes with:

    chore(qa): R1 round 6 — milestone complete

Do not edit other files or code.
