# Data Model: Search profiles

## Entity: SearchProfile

| Field | Type | Rules |
|---|---|---|
| `id` | string | Stable; format `sp_` + 8–16 lowercase hex/uuid fragment; assigned on create |
| `title` | string | 1–80 chars; trimmed; unique **per tenant** (case-insensitive) |
| `queries` | string[] | 1–24 items after trim; each 1–64 chars; at least one of queries/locations non-empty required — **both** may not be empty |
| `locations` | string[] | 0–24 items; same length limits; may be empty if queries non-empty |
| `enabled` | boolean | default `true` on create |
| `updatedAt` | string | ISO-8601; set on every successful write |

Validation: reject if `queries.length === 0 && locations.length === 0`.

## Aggregate file

Path (relative to tenant root): `config/search-profiles.json`

```json
{
  "version": 1,
  "profiles": [ /* SearchProfile[] */ ]
}
```

- Stable key order when serializing: `version`, `profiles`; each profile keys: `id`, `title`, `queries`, `locations`, `enabled`, `updatedAt`.
- Idempotent PUT: same logical document → identical UTF-8 bytes (no churn of `updatedAt` if payload equal after normalize).

## Relationships

- Belongs to **Tenant** via filesystem path only (`tenants/{tenantId}/config/search-profiles.json`). No global table.
- **Scan run** reads enabled profiles at start; does not store profile id on M5 events in this feature (M4 JobMatch will bind `search_profile_id` later).
- **portals.yml**: sibling user-layer file; not a child of SearchProfile.

## State transitions

| From | Event | To |
|---|---|---|
| (none) | POST create | enabled or as requested |
| any | PATCH enabled | enabled/disabled |
| any | PUT upsert | fields replaced; id preserved |
| any | DELETE | row removed |

## DATA_CONTRACT

Add to User Layer:

| File | Purpose |
|---|---|
| `config/search-profiles.json` | Named search profiles (M2); never auto-updated by system updater |

