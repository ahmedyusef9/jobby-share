# Contract: Search profiles HTTP API

All routes: `withTenant` — tenant from session only.

## `GET /api/search-profiles`

**200**: `{ "profiles": SearchProfile[] }` sorted by `title` ascending.

Empty file / missing → `{ "profiles": [] }`.

## `POST /api/search-profiles`

Body:

```json
{ "title": "Staff Engineer Israel", "queries": ["staff engineer"], "locations": ["Israel", "Remote"], "enabled": true }
```

**201**: `{ "profile": SearchProfile }` (new `id`).

**400**: validation (empty title, empty queries+locations, title conflict).

**403**: no tenant context.

## `PUT /api/search-profiles/[id]`

Full upsert of fields except `id`. Idempotent.

**200**: `{ "profile": SearchProfile }`.

**404**: unknown id (do not create on PUT with foreign id — POST creates).

## `PATCH /api/search-profiles/[id]`

Body: `{ "enabled": boolean }` and/or partial field updates allowed for title/queries/locations with same validation.

**200**: `{ "profile": SearchProfile }`.

## `DELETE /api/search-profiles/[id]`

**204**: removed.

**404**: unknown id.

## Isolation

- Path param / body `tenantId` ignored for authorization.
- Cross-tenant id guess → 404 (not 403) to avoid leakage.

## CLI (non-HTTP)

Module: load profiles from `path.join(resolveRoot(), 'config/search-profiles.json')`.

Function: `resolveScanPortalsPath({ tenantRoot, portalsPath }) → { portalsPath, cleanup, mode: 'profiles' | 'portals-fallback' }`.

When `mode === 'profiles'`: caller must `cleanup()` after scan.

