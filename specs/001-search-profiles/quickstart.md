# Quickstart: Search profiles (M2)

## Preconditions

- Tenant root exists (`tenants/{id}/` or compose `CAREER_OPS_ROOT`).
- User signed in (web) or `JOBBY_TENANT_ID` set (CLI).

## Create two profiles (web)

1. Open `/search-profiles`.
2. Create “Staff Engineer Israel” with queries + locations; leave enabled.
3. Create “Remote platform”; set enabled off.
4. Confirm `config/search-profiles.json` under that tenant lists both.
5. Confirm `portals.yml` mtime/checksum unchanged.

## Scan uses enabled only

1. Start a scan from the UI or CLI for that tenant.
2. Expect title/location filters derived from the enabled profile only.
3. Disable all profiles → scan must error clearly.
4. Delete `config/search-profiles.json` → scan falls back to `portals.yml`.

## CLI check

```bash
export CAREER_OPS_ROOT=/path/to/data
export JOBBY_TENANT_ID=default
# after implement: node -e "...load profiles..." or dedicated test
node --test tests/search-profiles-store.test.mjs tests/resolve-query-source.test.mjs
```

## Isolation check

1. As tenant A, create a uniquely titled profile.
2. As tenant B, `GET /api/search-profiles` must not include A’s title.

## Not in this quickstart

- GitHub issue creation
- Appwrite collection
- JobMatch / global postings

