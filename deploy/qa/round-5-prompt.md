# R1 QA — Round 5 re-run (#54)

Use the standing prompt: deploy/qa/PROMPT.md with <ISSUE> = 54.

Current state: fix a534900 landed (refusal copy reads zeroKey from /api/clis).
Checks 1 (Config), 3 (MCP loop), 4 (isolation) PASSED in the previous run —
re-verify quickly for regression, then focus on check 2:

2. Member AI refusal surfaces all point at Account -> MCP:
   - Inbox Score link + Score button tooltips
   - /pipeline/open score CTA
   - assistant setup line
   Operator wording unchanged; /api/clis returns { clis: [], zeroKey: true }.

On PASS the R1 milestone is complete. Record via scripts/qa-ship.mjs as usual.
