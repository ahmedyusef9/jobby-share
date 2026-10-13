# Durable GitHub assets (jobby fork)

Upstream `update-system.mjs` replaces `.github/**`. Keep jobby-specific GitHub
configuration here.

**GitHub mutations (issues, labels, PRs) must use the built-in GitHub MCP server**
(`plugin-github-github`). Do not use `gh` CLI or custom sync scripts.

| Path | Purpose |
|---|---|
| `labels.json` | Seed labels via MCP `label_write` |
| `milestones.json` | ROADMAP M0–M9 + release milestones R1… (record GitHub milestone numbers here) |
| `milestone-map.json` | `JOBBY-BL-###` → milestone id |
| `WORKFLOW.md` | Branch model, feature lifecycle, BrowserMCP ship gate |
| `ISSUE_TEMPLATE/` | Copy into `.github/ISSUE_TEMPLATE/` after upstream update |

Install templates manually:

```bash
cp -R deploy/github/ISSUE_TEMPLATE .github/
```
