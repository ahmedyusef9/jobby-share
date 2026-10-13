# Feature Specification: M2 Search profiles per tenant

**Feature Branch**: `specs/001-search-profiles` (local Spec Kit pointer; do not switch `release/v0.6.0` for this artifact)

**Created**: 2026-08-30

**Status**: Draft

**Backlog**: JOBBY-BL-046 · GitHub #42 · `.jobby/ROADMAP.md` M2

**Input**: First bounded Spec Kit feature for Jobby — search profiles as the query source, replacing a single `portals.yml` query list.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Several named searches (Priority: P1)

A signed-in tenant creates more than one search profile (for example “Staff Engineer Israel” and “Remote platform”). Each profile has a title, query keywords, locations, and an enabled flag. The dashboard lists them all. Only enabled profiles are used when a scan starts.

**Why this priority**: ROADMAP M2 is the next product milestone. Today one `portals.yml` is the only query source, so a person cannot keep two searches without overwriting the file.

**Independent Test**: Create two profiles in one tenant; list them; disable one; a scan run uses only the enabled profile’s queries/locations.

**Acceptance Scenarios**:

1. **Given** a tenant with no profiles, **When** they create profile A, **Then** the tenant has exactly one profile stored under that tenant only.
2. **Given** profiles A (enabled) and B (disabled), **When** a scan starts, **Then** only A’s queries and locations are used.
3. **Given** tenant T1’s profiles, **When** tenant T2 lists profiles, **Then** T2 does not see T1’s rows.

---

### User Story 2 — CLI uses the same profiles (Priority: P1)

`scan.mjs` and related CLI entry points resolve queries from the tenant’s search profiles, not from a lone `portals.yml` query list. `CAREER_OPS_ROOT` + `JOBBY_TENANT_ID` (BL-026 `resolveRoot()`) stay the path authority.

**Why this priority**: ROADMAP: “the CLI toolchain reads them too.” Web-only profiles would split writers and silently scan the wrong jobs.

**Independent Test**: With `JOBBY_TENANT_ID` set, `scan.mjs --help` / a dry-run or unit test shows the enabled profile queries; the same tenant’s `portals.yml` is not the query source when profiles exist.

**Acceptance Scenarios**:

1. **Given** two enabled profiles, **When** CLI scan runs for that tenant, **Then** both profiles’ queries are included (union or sequential — recorded in plan; must be deterministic).
2. **Given** no profiles, **When** CLI scan runs, **Then** it falls back to existing `portals.yml` behaviour and does not crash.

---

### User Story 3 — Idempotent edits (Priority: P1)

Saving the same profile twice (same id, same fields) does not create a duplicate. PATCH/PUT with unchanged payload is a no-op on stored bytes/identity.

**Why this priority**: ROADMAP: “editing one is idempotent.” Agents and the UI will retry saves.

**Independent Test**: PUT the same JSON twice; row count stays 1; `id` unchanged.

**Acceptance Scenarios**:

1. **Given** profile id `sp_1`, **When** the same document is saved twice, **Then** there is still one row with that id.
2. **Given** profile id `sp_1`, **When** only `enabled` flips, **Then** queries/locations are unchanged and `enabled` matches the last write.

---

### Edge Cases

- Empty queries and empty locations: refuse the write with a validation error; do not start a scan that means “everything.”
- All profiles disabled: scan must fail closed with a clear error, not silently scan every portal.
- Profile title uniqueness is per tenant, not global; two tenants may both have “Default.”
- `portals.yml` remains a **user-layer** file (`DATA_CONTRACT.md`). This feature must not delete or auto-rewrite it. Profiles **supersede it as the query source** when at least one enabled profile exists.
- Explorer’s ephemeral temp `portals.yml` (`web/src/lib/core/portals.ts`) stays ephemeral; it must not be confused with stored search profiles.
- No fabrication of CV/comp facts; profiles are search intent only.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST persist many search profiles per tenant: `id`, `title`, `queries`, `locations`, `enabled`.
- **FR-002**: System MUST scope every read/write to the authenticated tenant; never take tenant id from untrusted body fields as authority.
- **FR-003**: Users MUST be able to create, list, update, and disable/enable profiles without leaving the tenant dashboard.
- **FR-004**: When one or more enabled profiles exist, scan MUST use those profiles as the query/location source instead of `portals.yml` title/location filters.
- **FR-005**: CLI scan MUST use the same tenant-scoped profile store as the web app.
- **FR-006**: Profile updates MUST be idempotent by stable `id`.
- **FR-007**: System MUST NOT mutate `DATA_CONTRACT.md` user-layer files except the new profile store; do not overwrite `portals.yml` as a side effect of profile CRUD.
- **FR-008**: GitHub issue tracking stays on `ahmedyusef9/jobby` via GitHub MCP only; this spec does not create issues unless the owner asks.

### Key Entities

- **SearchProfile**: tenant-owned named search intent (`title`, query strings, locations, enabled).
- **Tenant**: existing BL-020/M1 identity; profile rows never live on a global/shared catalog (that is M3).
- **Scan run**: existing M5 scan; must bind to enabled profiles for this tenant only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All four ROADMAP M2 boxes can be evidenced with commands or API responses, not agent assertion.
- **SC-002**: Two-tenant test: T1 profiles never appear in T2 list or T2 scan.
- **SC-003**: Double-save of one profile does not increase row count.
- **SC-004**: `portals.yml` on disk is unchanged after profile CRUD (checksum or mtime).

## Assumptions

- BL-020 tenant root and BL-026 CLI `resolveRoot()` are already in the tree (status Ready / verified in backlog notes). This feature does not re-open tenancy.
- M3 canonical `job_postings` and M4 `JobMatch` are **out of scope**.
- Storage may be Appwrite (backlog says tenant-scoped) or a tenant file under the tenant root; the plan MUST pick one and keep CLI+web on that one store.
- No Spec Kit Git extension; no `gh`; no commit unless the owner asks.

## Constitution alignment

`.specify/memory/constitution.md`: product truth is `AGENTS.md`, `DATA_CONTRACT.md`, `.jobby/GITHUB.md`, ROADMAP, backlog. This spec cites JOBBY-BL-046 / #42 / M2 and does not invent a second backlog.

