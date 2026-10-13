# R1 QA — Round 3 prompt (paste into Cursor)

R1 QA round 3 on release/v0.5.0 @ 8c1f4f9.

Preconditions:
- git pull origin release/v0.5.0
- docker compose -f deploy/docker-compose.yml up --build -d   (rebuild BOTH web and worker)

Re-run ONLY these, from the round-2 checklist:

1. #51 resume_generate {} → ok:true + download_link; open the link logged-out
   in a private window → PDF renders. Worker log must NOT contain a js-yaml
   SyntaxError.

2. #52 jobs_fetch {} → exactly ONE markdown table, full schema
   (Company | Role | Location | Posted | Status | Score | Posting | Jobby),
   NOTHING after the last row — no instruction line, no meta footer.

3. #53 submit_score on the SAME row used in round 2 (it already has a score):
   - first call → updated:true (provenance rewritten in place)
   - identical second call → updated:false, idempotent:true
   - /pipeline?tab=EVALUATED → row shows 4.2/5 AND a clean single
     [scored-by: openai/gpt-5.2 · 4.2/5 · <date>] tag in the Notes column,
     no truncated junk fragments around it.

4. #50 RBAC — include only if not already closed: /admin/rbac loads, matrix
   editable, audit row appears after Publish; /admin has the Role column.

Recording verdicts (run in terminal, do NOT close issues by hand):

    node scripts/qa-ship.mjs <issue#> pass --evidence "<what you verified>"
    node scripts/qa-ship.mjs <issue#> fail --note "<steps, expected vs actual>"

After all four: report a summary table (# / verdict / evidence) and commit any
tracker changes the script made with message:

    chore(qa): R1 round 3 — <N>/4 shipped

Do not edit other files or code.
