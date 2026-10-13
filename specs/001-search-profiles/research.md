# Research: 001-search-profiles

**Date**: 2026-08-30

## Decision 1 — Storage: tenant JSON file vs Appwrite

**Decision**: `config/search-profiles.json` under the tenant root.

**Rationale**:
- Spec requires CLI and web to share one store (FR-005).
- CLI/worker already resolve paths via `CAREER_OPS_ROOT` + `JOBBY_TENANT_ID` / `tenantRoot()`; they do not hold an Auth.js/Appwrite user session for arbitrary tenants.
- Existing user-layer pattern (`portals.yml`, `config/profile.yml`) + `atomicWriteWithBackup` matches crash-safety expectations.
- BL-046 backlog text says “Appwrite tenant-scoped” as a candidate; ROADMAP M2 does not require Appwrite specifically. Defer Appwrite until a later migration if multi-device sync without filesystem is required.

**Rejected**: Appwrite collection as SoT for M2 — would force CLI to use server API keys and invent a second auth path; risk of web/CLI split.

## Decision 2 — How scan consumes profiles without rewriting portals.yml

**Decision**: Merge real `portals.yml` → override `title_filter` / `location_filter` from enabled profiles → write ephemeral file → set `CAREER_OPS_PORTALS` (same env `scan.mjs` already honors). Delete temp file after scan.

**Rationale**: Explorer already uses ephemeral portals via `writeTempPortals` for ad-hoc filters. Full scan needs `tracked_companies` preserved; merge-copy is safer than filter-only YAML.

**Rejected**: In-place rewrite of `portals.yml` on each scan — violates FR-007 / DATA_CONTRACT.

## Decision 3 — Multiple enabled profiles: union vs sequential scans

**Decision**: **Union** of queries/locations across enabled profiles (deterministic sort by `id`).

**Rationale**: One scan admission path (M5) already budgets cost; sequential full scans per profile would multiply ATS traffic without a product UI for “which profile ran.” Union matches “queries are included” acceptance and stays one job.

**Rejected**: Sequential per-profile scans for M2 — defer until product asks for per-profile run reports.

## Decision 4 — Fail-closed when all profiles disabled

**Decision**: If the profiles file exists and length > 0 and none enabled → scan error. If file missing → portals.yml fallback.

**Rationale**: Spec edge case; avoids silent “scan everything.”

## Decision 5 — UI placement

**Decision**: Dedicated `/search-profiles` page (or tab) listing profiles; keep existing `/portals` for company list / portals.yml title seed. Profile CRUD does not call current `POST /api/portals`.

**Rationale**: Separates curated company list from named search intents; reduces accidental portals.yml clobber.

## Open items (none blocking plan)

- Exact JSON schema field names locked in `data-model.md`.
- Whether soft-delete (`enabled: false` only) vs hard DELETE — plan allows DELETE to remove row; disable via PATCH is enough for “enabled flag.”

