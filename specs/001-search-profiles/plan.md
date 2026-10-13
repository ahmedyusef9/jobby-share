# Implementation Plan: M2 Search profiles per tenant

**Branch**: `001-search-profiles` (Spec Kit pointer only; stay on `release/v0.6.0` until an implement branch is cut) | **Date**: 2026-08-30 | **Spec**: [`spec.md`](./spec.md)

**Input**: Feature specification from `/specs/001-search-profiles/spec.md`

**Backlog**: JOBBY-BL-046 · GitHub #42 · `.jobby/ROADMAP.md` M2

## Summary

Give each tenant many named **search profiles** (title, queries, locations, enabled). Persist them in a **tenant-root JSON file** so web and CLI share one store via `tenantRoot()` / `resolveRoot()`. When any profile is enabled, scan builds an **ephemeral** title/location filter (union of enabled profiles) and points the scanner at it with `CAREER_OPS_PORTALS` — same pattern as Explorer — so the curated `portals.yml` (companies, providers) is never rewritten by profile CRUD. No profiles → existing `portals.yml` behaviour.

## Technical Context

**Language/Version**: TypeScript (Next.js web) + Node ESM `.mjs` CLI (existing toolchain)

**Primary Dependencies**: Existing `withTenant` / `tenantRoot` / `resolveRoot`; `js-yaml`; `atomicWriteWithBackup`; `scan.mjs` + `CAREER_OPS_PORTALS`

**Storage**: Tenant-scoped file `config/search-profiles.json` under the tenant root (user-layer). **Not** Appwrite for M2 — CLI has no Appwrite session; file store keeps web+CLI identical. Appwrite can come later if M3/M4 need it; M2 does not.

**Testing**: Node native tests under `tests/` (profile store + resolveQuerySource); web route tests if a pattern already exists for portals; two-tenant isolation via `withTenant` / separate tenant roots

**Target Platform**: Local compose / Railway web+worker; CLI on tenant checkout

**Project Type**: Web app + CLI monorepo (`web/` + root `.mjs`)

**Performance Goals**: Profile list/CRUD < 100ms local disk; scan path adds one JSON read + temp portals write (negligible vs ATS HTTP)

**Constraints**: Never take tenant id from client body as authority; never rewrite `portals.yml` on profile CRUD; empty queries+locations rejected; all-disabled fail closed; GitHub MCP only (no `gh`)

**Scale/Scope**: Alpha tenants (tens); ≤ ~20 profiles per tenant is enough for M2

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Gate | Status |
|---|---|
| I. Product truth (ROADMAP M2, BL-046, DATA_CONTRACT) cited — no second backlog | PASS |
| II. No fabricated CV/comp; new store is search intent only; `portals.yml` not auto-deleted | PASS |
| III. No `gh`; issues only if owner authorizes later | PASS |
| IV. Red-green tests required before claiming M2 done | PASS (plan requires tests) |
| V. Bounded to BL-046; M3/M4 out of scope | PASS |

**Post-design re-check**: File store + ephemeral filters stay inside existing modular boundaries; DATA_CONTRACT must gain one user-layer row for `config/search-profiles.json` during implement — not a silent user-layer invent.

## Project Structure

### Documentation (this feature)

```text
specs/001-search-profiles/
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1
│   └── search-profiles-api.md
└── tasks.md             # Phase 2 — NOT created by this command
```

### Source Code (repository root)

```text
web/src/lib/core/search-profiles.ts     # load/save/validate/idempotent upsert
web/src/lib/core/resolve-query-source.ts # enabled profiles → ephemeral portals filters
web/src/app/api/search-profiles/route.ts # GET list / POST create
web/src/app/api/search-profiles/[id]/route.ts # PUT upsert / PATCH enabled / DELETE disable-or-remove
web/src/app/search-profiles/page.tsx     # minimal dashboard list + form (or extend portals page)
web/src/components/search-profiles-view.tsx

scripts/search-profiles.mjs              # shared read helpers for CLI (or import from a small .mjs module)
scan.mjs                                 # call resolveQuerySource before title_filter build

tests/search-profiles-store.test.mjs
tests/resolve-query-source.test.mjs

DATA_CONTRACT.md                         # add config/search-profiles.json to User Layer
```

**Structure Decision**: Reuse `web/src/lib/core/*` + root CLI (same as portals/scan). No new package. No Appwrite collection for M2.

## Complexity Tracking

> No constitution violations requiring justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Phase 0 / Phase 1 outputs

See `research.md`, `data-model.md`, `contracts/search-profiles-api.md`, `quickstart.md`.

## Implementation notes (for `/speckit-tasks`)

1. **Union rule (deterministic)**: Sort enabled profiles by `id` ascending. Concatenate `queries` then `locations`, de-dupe case-insensitively preserving first-seen order. Map to ephemeral `title_filter.positive` + `location_filter.allow`.
2. **Companies**: Always load `tracked_companies` (and non-filter blocks) from the real `portals.yml`. Ephemeral file = filters only **or** merge: copy full portals.yml then override title/location filters — prefer **merge copy** so scan.mjs needs no second config path.
3. **Fail closed**: If `config/search-profiles.json` exists and every profile has `enabled: false`, scan exits with a clear error (do not fall through to portals title filters).
4. **Fallback**: File missing or empty array → current portals.yml-only behaviour.
5. **Idempotent PUT**: Upsert by `id`; identical payload → same file bytes (stable JSON key order).
6. **Out of scope**: JobMatch, global job_postings, Appwrite SearchProfile collection, GitHub issue creation.

