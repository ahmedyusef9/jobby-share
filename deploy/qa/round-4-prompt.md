# R1 QA — Round 4 prompt (paste into Cursor)

R1 QA round 4 on release/v0.5.0 @ 3960ad2.

Preconditions:
- git pull origin release/v0.5.0
- docker compose -f deploy/docker-compose.yml up --build -d   (rebuild BOTH web and worker)

Only #51 and #53 remain. Re-run:

1. #51 resume_generate full chain:
   - resume_generate {} → ok:true AND download_link present in the response.
   - Open download_link logged-out in a private window → PDF renders (no 401).
   - Filename with spaces must also serve if that is what export produced.

2. #53 submit_score provenance hygiene on the SAME row as round 3:
   - submit_score {job_id:<n>, score:4.2, scored_by:"openai/gpt-5.2"} (no
     rationale) → updated:true this time: dirty round-3 notes get rewritten.
   - Notes column now shows ONE clean tag [scored-by: openai/gpt-5.2 · 4.2/5 ·
     <date>] FIRST, no truncated fragments anywhere.
   - Identical call again → updated:false, idempotent:true.

Recording verdicts (terminal, never close issues by hand):

    node scripts/qa-ship.mjs <issue#> pass --evidence "<what you verified>"
    node scripts/qa-ship.mjs <issue#> fail --note "<steps, expected vs actual>"

Both PASS → milestone R1 has every issue closed; report the final table and
commit tracker changes with:

    chore(qa): R1 round 4 — shipped

Do not edit other files or code.
