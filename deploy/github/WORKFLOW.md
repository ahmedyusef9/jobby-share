# Delivery workflow — version branches, feature branches, BrowserMCP ship gate

Fast-delivery process for the jobby fork. GitHub is the single source of traceability:
every feature = one `JOBBY-BL-NNN` row in `implementation_backlog.csv` = one issue.

## 1. Branch model

```
main (or master) ── tag vX.Y.Z on ship
  └── release/vX.Y.Z        ← one per version; integration branch
        ├── feat/bl-054-rbac-console
        ├── feat/bl-055-mcp-resume-tools
        └── ...
```

| Rule | Detail |
|------|--------|
| Version branches | `release/vMAJOR.MINOR.PATCH` — created from main at release start; carries the milestone (e.g. R1 → `release/v0.5.0`) |
| Feature branches | `feat/<bl-lowercase>-<short-slug>` off the **release** branch, never off main |
| Merge target | A feature merges into its **release** branch only if it belongs to that release's milestone; otherwise it waits on its own branch or targets a later release |
| Ship | Release branch → BrowserMCP QA pass → merge to main → tag `vX.Y.Z` → close the milestone |
| Hotfixes | `hotfix/*` from main, merged back to main **and** the active release branch |

## 2. Feature lifecycle (traced end-to-end)

1. **Propose** — CSV row (Status=Proposed) + GitHub issue (`status:proposed`, milestone set)
2. **Start** — cut `feat/...` branch; flip label to `status:in-progress`; move CSV Status to In Progress
3. **Build** — commits reference the BL id (`BL-054: ...`) so history traces back
4. **Verify** — Cursor + browsermcp runs the scripted UI pass against local compose/staging:
   checklist: `deploy/qa/R1-pass.md` · skill: `.cursor/skills/qa-pass/SKILL.md`
   - PASS → agent records it: `node scripts/qa-ship.mjs <issue#> pass --evidence "…"`
     (flips labels to `status:done`, closes issue with evidence, sets CSV Status=Done), merges feature branch into the release branch
   - FAIL → `node scripts/qa-ship.mjs <issue#> fail --note "…"` posts evidence on the issue; branch stays unmerged
5. **Release** — all milestone issues closed → merge release branch to main → tag → milestone auto-closes

## 3. Active release

| Field | Value |
|-------|-------|
| Branch | `release/v0.5.1` |
| Milestone | R2 — Automated UI e2e (#12) |
| Scope | BL-060–065 (harness, rbac/zero-key/mcp-tools specs, CI wiring, RBAC matrix doc) |

## 4. Product rule for R1 (binding)

Members are **zero-key**: no API keys from users, no host-side LLM scoring.
All scoring intelligence happens in the user's own assistant via MCP
(`jobs_fetch` → external score → `submit_score` write-back). Jobby stays an
isolated multi-tenant data hub with RBAC management.
