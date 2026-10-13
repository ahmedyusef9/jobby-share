---
name: sdlc-report
description: Render the formal task and handoff report. Use for bounded delivery, investigation, review, QA, release, cross-agent handoff, status, completion, blocker, or verification reports.
---

# Formal task report (jobby)

Canonical schema: `~/.cursor/skills/sdlc-report/SKILL.md`. Do not drop `SUMMARY`.

Jobby-only identity rules (this repo has no Agent OS controller):

- `TASK_ID` — a real **jobby** issue (`#42` from `.jobby/github-issues.tsv`) or backlog id
  (`JOBBY-BL-020`) when one identifies the work, else `N/A`. Never use upstream
  `santifer/career-ops` issue numbers for jobby product work.
- `MESSAGE_ID` — `N/A` unless the user has established a numbering scheme in this thread.
- Never invent persistent state or provider-specific IDs.
- Flag in `RISKS` when any changed file is system-layer, since the next
  `node update-system.mjs apply` will revert it.
- `TESTS` cites `node test-all.mjs`, `go test ./...`, or `node eval-golden.mjs`
  and the actual result. Never claim a suite passed from `--quick` or `--only`.
