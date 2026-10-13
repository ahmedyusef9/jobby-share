# Architecture

This file describes the runtime flows. Design principles and the
system/user data-contract layers live in [../ARCHITECTURE.md](../ARCHITECTURE.md).

## System Overview

```
                    ┌─────────────────────────────────┐
                    │         AI Coding CLI Agent      │
                    │   (reads AGENTS.md + modes/*.md) │
                    └──────────┬──────────────────────┘
                               │
            ┌──────────────────┼──────────────────────┐
            │                  │                       │
     ┌──────▼──────┐   ┌──────▼──────┐   ┌───────────▼────────┐
     │ Single Eval  │   │ Portal Scan │   │   Batch Process    │
     │ (auto-pipe)  │   │  (scan.md)  │   │   (batch-runner)   │
     └──────┬──────┘   └──────┬──────┘   └───────────┬────────┘
            │                  │                       │
            │           ┌──────▼──────┐          ┌────▼─────┐
            │           │ pipeline.md │          │ N workers│
            │           │ (URL inbox) │          │ (headless)
            │           └─────────────┘          └────┬─────┘
            │                                          │
     ┌──────▼──────────────────────────────────────────▼──────┐
     │                    Output Pipeline                      │
     │  ┌──────────┐  ┌────────────┐  ┌───────────────────┐  │
     │  │ Report.md│  │  PDF (HTML  │  │ Tracker TSV       │  │
     │  │ (A-G eval)│  │  → Playwright)│ │ (merge-tracker)  │  │
     │  └──────────┘  └────────────┘  └───────────────────┘  │
     └────────────────────────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  data/applications.md │
                    │  (canonical tracker)  │
                    └──────────────────────┘
```

## MCP Runtime and Access Flow

```mermaid
flowchart TD
  C[ChatGPT / Claude / Cursor] -->|HTTPS :8443| F[Tailscale Funnel\nMCP-only public host]
  F --> R[/api/mcp or /mcp/jb_token\nStreamable HTTP + SSE]
  R --> G[Transport guards\npayload · schema · budgets · lockout]
  R --> T[Connect-key lookup\nAppwrite mcp_tokens]
  T --> A{active and unexpired?}
  A -->|no| U[401 unauthorized / expired]
  A -->|yes| X[tenantId + read/read-write scope]
  X --> Q[account quota + scope gate]
  Q --> D[tenant-scoped MCP tool dispatch]
  D --> S[CV · tracker · pipeline · reports\ninside tenant root]
  D --> E[usage events / audit metadata]

  M[Member session] --> K[/connect + /api/account/mcp]
  K -->|own tenant only| T
  O[Operator session] --> P[/admin + /admin/rbac]
  P --> V[account/RBAC metadata\nno tenant content or raw keys]

  QA[Conformance + multi-level + Funnel E2E] -. verifies .-> R
  QA -. verifies .-> Q
  QA -. verifies .-> V
```

Access invariants:

- A Connect key supplies tenant identity, scope, and expiry; request query parameters never select a tenant.
- `read` keys can call read tools but the centralized write-tool gate rejects mutations.
- Suspended, expired, revoked, and unknown keys cannot call tools.
- Members manage only their own key metadata; operators see account/RBAC metadata, never raw key secrets or tenant CV/tracker/report content.
- `:8443` is the restricted MCP client origin; external browser release QA uses a separate full-app Funnel origin.

Implementation and evidence: `web/src/app/api/mcp/route.ts`, `web/src/lib/mcp/handler.ts`, `scripts/mcp-tokens.mjs`, `deploy/docs/mcp-funnel.md`, and `deploy/qa/mcp-multi-user-matrix.md`. R3 tracking: #64, #66, #67, #71, #72, #73, #74.

## Evaluation Flow (Single Offer)

1. **Input**: User pastes JD text or URL
2. **Extract**: Playwright/WebFetch extracts JD from URL
3. **Classify**: Detect archetype (1 of 6 types)
4. **Evaluate**: 7 blocks (A-G):
   - A: Role summary
   - B: CV match (gaps + mitigation)
   - C: Level strategy
   - D: Comp research (WebSearch)
   - E: CV personalization plan
   - F: Interview prep (STAR stories)
   - G: Posting legitimacy (scam / ghost-job signals)
5. **Score**: Weighted average across 5 dimensions (1-5)
6. **Report**: Save as `reports/{num}-{company}-{date}.md`
7. **PDF**: Generate ATS-optimized CV (`generate-pdf.mjs`)
8. **Track**: New entries via TSV in `batch/tracker-additions/` merged by
   `merge-tracker.mjs`; status updates to existing rows via `set-status.mjs`

## Batch Processing

The batch system processes multiple offers in parallel:

```
batch-input.tsv    →  batch-runner.sh  →  N × headless CLI workers
(id, url, source)     (orchestrator)       (self-contained prompt)
                           │
                    batch-state.tsv
                    (tracks progress)
```

Each worker is a headless AI CLI instance — the bundled `batch-runner.sh` currently runs `claude -p` workers only. See the Headless / Batch Mode table in `AGENTS.md`. Workers produce:
- Report .md
- PDF
- Tracker TSV line

The orchestrator manages parallelism, state, retries, and resume.

## Data Flow

```
cv.md                    →  Evaluation context
article-digest.md        →  Proof points for matching
config/profile.yml       →  Candidate identity
portals.yml              →  Scanner configuration
templates/states.yml     →  Canonical status values
templates/cv-template.html → PDF generation template
```

## File Naming Conventions

- Reports: `{###}-{company-slug}-{YYYY-MM-DD}.md` (3-digit zero-padded)
- PDFs: `cv-candidate-{company-slug}-{YYYY-MM-DD}.pdf`
- Tracker TSVs: `batch/tracker-additions/{id}.tsv`

## Pipeline Integrity

Scripts maintain data consistency:

| Script | Purpose |
|--------|---------|
| `merge-tracker.mjs` | Merges batch TSV additions into applications.md |
| `verify-pipeline.mjs` | Health check: statuses, duplicates, links |
| `dedup-tracker.mjs` | Removes duplicate entries by company+role |
| `normalize-statuses.mjs` | Maps status aliases to canonical values |
| `cv-sync-check.mjs` | Validates setup consistency |

## Dashboard TUI

The `dashboard/` directory contains a standalone Go TUI application that visualizes the pipeline:

- Filter tabs: All, Evaluada, Aplicado, Entrevista, Top >=4, No Aplicar
- Sort modes: Score, Date, Company, Status
- Grouped/flat view
- Lazy-loaded report previews
- Inline status picker
