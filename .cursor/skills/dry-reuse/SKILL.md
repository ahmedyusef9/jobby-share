---
name: dry-reuse
description: >-
  Enforce Don't Repeat Yourself (DRY) in jobby web/UI work: extract once, reuse
  via shared components/helpers, never copy-paste Job info / status / Apply /
  PDF controls across pages. Use when adding screens, duplicating UI, or
  wiring Pipeline ↔ Workers role detail.
---

# DRY reuse (write once)

## Rule (verbatim)

add this DRY into your skills

Don't Repeat Yourself. Write once and use it again. Do not re-implement the same
click path, Job info card, status control, Generate CV, Apply, or URL copy on a
second page.

## When this applies

- New Pipeline / Workers / report / inbox surfaces that show a role
- Any UI that would otherwise copy StatusSelect, GeneratePdfButton, ApplyButton,
  Copy URL, or "Job info" layout
- Deep links between list → detail (one href helper, one detail page)

## Do this

1. **Find the existing component** before writing a new one (`JobInfoPanel`,
   `rolePageHref`, `StatusSelect`, etc.).
2. **Extract** shared UI into `web/src/components/` (or `web/src/lib/` for
   pure helpers). One export, many call sites.
3. **Navigate once** — list row click goes straight to the role page
   (`/pipeline/[n]` or `/pipeline/open?url=…`). No side pane that forces a
   second "Open…" click for the same actions.
4. **Compose with props / `footer` slots** instead of forking the whole card.
5. If two pages need the same block, the second page **imports** — it does not
   paste.

## Canonical role UI (jobby web)

| Concern | Single source |
|--------|----------------|
| Job info + status + PDF + Apply + copy URL | `web/src/components/job-info-panel.tsx` |
| Href for a role | `web/src/lib/role-href.ts` → `rolePageHref()` |
| Scored report page | `/pipeline/[n]` (`ReportView` + `JobInfoPanel`) |
| Unscored inbox role | `/pipeline/open` (same `JobInfoPanel`) |
| Live worker run | `/jobs/[id]` (same `JobInfoPanel`) |

## Anti-patterns

- Duplicating Status / Generate CV / Apply in a list detail pane **and** on
  Workers / report
- `?job=` master-detail that reimplements the Workers page
- Parallel "Open in Pipeline" / "Full report" hops when the row click should
  already land on that page
- New markdown docs explaining DRY instead of extracting the component

## Checklist before merge

- [ ] Grep shows one implementation of the shared control
- [ ] List → detail is a single navigation
- [ ] CHANGELOG notes the extract if behavior changed
