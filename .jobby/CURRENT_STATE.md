# Current state

Regenerate this before starting a milestone. Everything here was read from the
running system, not remembered.

_Last verified: 2026-09-10 — ChatGPT MCP origin is `:443` `/mcp/…` (no port). `:8443` is Cursor/QA only. Compose `127.0.0.1:4700`. Issue #87._

_Prior milestone stamp: 2026-08-23 — **R1 SHIPPED (v0.5.0)**; infra sections below verified 2026-08-18_

## R1 — MCP-first platform · build status 2026-08-23

Milestone [#11](https://github.com/ahmedyusef9/jobby/milestone/11) · release branch `release/v0.5.0` · workflow: `deploy/github/WORKFLOW.md`

| BL | Feature | State | Where |
|----|---------|-------|-------|
| 054 | RBAC console v2 | ✅ done — closed after QA rounds 1-5 | issue #50 |
| 055 | MCP resume toolkit | ✅ done — signed links verified logged-out (round 4) | issue #51 |
| 056 | MCP job feed (`jobs_fetch`) | ✅ done — verbatim bare table verified (round 3) | issue #52 |
| 057 | MCP score write-back (`submit_score`) | ✅ done — idempotent, provenance visible (round 4) | issue #53 |
| 058 | Zero-key member experience | ✅ done — all refusal surfaces point at MCP (round 6) | issue #54 |
| 059 | BrowserMCP QA pipeline | ✅ done — shipped rounds 1-6 by demonstration | issue #55 |

Shipped this round, all tenant-scoped and quota-gated:

- `resume_upload` / `resume_update` / `resume_download_link` (HMAC-signed ~15-min URLs via `/api/resume/{token}`) / `resume_generate` (Chromium render, zero AI calls; core shared with web export in `lib/cv/export-core.ts`)
- `jobs_fetch` — one verbatim contract table over inbox+tracker with source/status/date filters and paging
- `submit_score` — external-AI verdict write-back with mandatory `scored_by` provenance, idempotent re-submit
- RBAC v2: live plan-cap overrides (`applyPlanCapOverrides` + `/api/admin/rbac`), role grant/revoke that kills sessions mid-flight, JSONL audit trail with before→after rows, `/admin/rbac` matrix editor

Integration rule used: feature branches merge into `release/v0.5.0` when they belong to R1;
**nothing reaches main until the BrowserMCP QA pass (BL-059) closes each issue**.

Tests at last run: entitlements 16/16, rbac-overrides 6/6, resume-links 5/5, mcp-job-card 9/9,
tracker-mutate 3/3 — plus `tsc --noEmit` clean on every slice.
Not yet re-run: full `node test-all.mjs` suite.

---

## Previous verification snapshot (2026-08-18)

The 10-account product is now: resume, explore (query/country/distance), pipeline without host Score, rules/export, and MCP at `/mcp/jb_…` on Tailscale Funnel `:8443`. Host member Score is deferred (D-029). Stripe is not in this release; the operator assigns free/$5/$10/$20.

`mcp_tokens` collection is live (schema applied 2026-08-18). Operator MCP key prefix `jb_…` is in gitignored `.mcp.json`, `~/.cursor/mcp.json`, and `~/.claude.json`. Connect UI is on Config (`#mcp`) and the sidebar; Account reuses the same panel. Tailscale Funnel already proxies `/api/mcp` at `https://your-machine.your-tailnet.ts.net:8443` → `127.0.0.1:3001`; `JOBBY_MCP_PUBLIC_URL` is set so Config mints that origin. The web UI stays on loopback. Web image rebuilt; `jobby-deploy-web-1` on `127.0.0.1:3001`.

## Tests

`node test-all.mjs` was not re-run for this pivot (upstream 67 failures are unchanged debt).

`node --test tests/*.test.mjs` → **255 pass, 0 fail** (2026-08-18, includes MCP token/quota/jsonrpc tests).

## Appwrite (`jobby` database, type: legacy)

| Collection | Documents |
|---|---|
| `tenants` | 3 |
| `identities` | 3 |
| `provider_keys` | 0 |
| `usage_events` | 8 |
| `app_config` | 1 (`1.0.0` active) |
| `batches` | 1 (`alpha-1`, open, capacity 10) |
| `capacity_slots` | 4 |
| `job_events` | 0 (collection created 2026-08-18) |

Account state lives in `tenants` + `identities`. `provider_keys` stays empty until
the key store moves off disk.

## What a run costs, measured

Read from the live tenants, not estimated:

| Tenant | Pending postings | Would evaluate | Dropped, with a reason | Deferred |
|---|---|---|---|---|
| `default` (operator) | 1622 | 25 | 119 | 1478 |
| `t_<tenant>` (member) | 915 | 25 | 0 | 890 |

The member's pipeline came straight from a filtered scan, so the hard gates find
nothing left to disqualify and the budget is doing all the work — which is exactly
why the budget has to hold when the gates do nothing.

## Deployment

Compose project renamed `deploy` → **`jobby-deploy`**: the repo-root (upstream
career-ops) compose already claims the project name `jobby`, so sharing it would make
each stack look like the other's orphans. Containers are `jobby-deploy-{web,worker,redis}-1`.

What the host publishes, read from `docker ps` rather than from the file:

| Service | Published | Reachable from |
|---|---|---|
| web | `127.0.0.1:3001->3000` | this machine only — LAN and tailnet both refuse |
| redis | nothing | inside `jobby_internal` only |
| worker | nothing | — |

The stack had drifted from its own file: it was still running the pre-sandbox
definition on `deploy_default`, with **Redis published on `0.0.0.0:6379` and no
password**, so anything on the network could read or forge queue entries. Recreating
the stack from the current file closed that; there were 0 waiting and 0 active jobs at
the time.

Appwrite is self-hosted over Tailscale. Alpha batch `alpha-1`, capacity 10.
Operator screens are `/admin` and `/admin/runs`.
Set `JOBBY_HOST_ROOT` to this checkout's absolute path before compose sandbox runs.

## What the ledger says about runs

15 runs recorded, and **none of them succeeded**: 10 `incomplete` (6 `missing_tracker`,
4 `missing_report`, each after 1–2 minutes of work) and 5 `failed` inside 12–194 ms,
which is a start-up failure rather than a model one. All `evaluate`, all engine
`opencode`, all on the `default` tenant. This is a real product defect that the new
screen surfaces; it is not caused by the screen.

## Debt with a name

- Nothing surfaces scan progress or the filter's verdict in the Workers UI — the
  numbers exist only in `GET /api/scans` and the worker log
- `openrouter-runner.mjs` carries a local patch (tenant-scoped file resolution and
  the filter call); re-apply it after `node update-system.mjs apply`
- Dropped pipeline rows stay pending forever — refused again free each run, but
  nothing prunes them
- OAuth still uses `AUTH_ALLOWED_EMAILS` instead of capacity — contradicts D-004
- Appwrite schema is an imperative script, not `appwrite.config.json`
- Test accounts hold capacity slots; the Appwrite API key needs rotating
- Rebuild the worker image before sandbox jobs run (`JOBBY_SANDBOX=1`)
- `/admin/runs` is still phase 2; round-robin tenant dispatch is later (D-023 is the interim 1+1 cap)
