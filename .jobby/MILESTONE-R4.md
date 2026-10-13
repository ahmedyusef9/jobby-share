# R4 — Search profiles and exact-date discovery

A connected assistant can explain which tenant and search profile it is using, then fetch jobs for an exact historical date range without silently substituting a rolling window.

## Scope

- Make the effective search query inspectable over MCP: tenant, active profile, keywords, exclusions, locations, country, sources, and defaults.
- Introduce tenant search profiles as the canonical query source, aligned with roadmap M2.
- Add inclusive `date_from` and `date_to` (`YYYY-MM-DD`) to `explore_jobs` and `job_table`.
- Keep `since_days` for rolling searches; reject ambiguous requests that combine rolling and exact-date filters.
- Filter returned rows by normalized `postedAt`, report unknown dates separately, and never label out-of-window rows as matches.
- Verify the real ChatGPT, Cursor, and Claude connections against the existing public MCP endpoint under #83.

## Acceptance criteria

- [x] `whoami` identifies the tenant and active search profile and returns the effective query without exposing secrets.
- [x] A user can create, select, edit, disable, and list multiple tenant-scoped search profiles.
- [ ] `explore_jobs({ date_from: "2026-09-04", date_to: "2026-09-05", country: "Israel" })` returns only postings dated September 4–5, 2026, inclusive.
- [ ] Results preserve the original `Company | Role | Location | Posted | Posting | Jobby` output contract.
- [ ] Empty results include source counts, applied filters, and unknown/out-of-window counts instead of an unexplained empty payload.
- [ ] Invalid dates, reversed ranges, and `since_days` combined with an exact range return actionable validation errors.
- [ ] Automated tests cover tenant isolation, timezone boundaries, unknown posting dates, both exact endpoints, and no-result diagnostics.
- [ ] Physical-client evidence exists for ChatGPT, Cursor, and Claude; this remains manual-only and is tracked by #83.

## Out of scope

- A new hosting platform or authentication scheme; public MCP and per-tenant keys already exist.
- New rate limiting; current per-tenant MCP and result quotas already exist.
- Generic documentation work unrelated to this journey.

## Delivery order

1. Search-profile storage and MCP inspection.
2. Exact-date filtering and diagnostics.
3. Automated contract tests.
4. Physical-client QA under #83.

## Status

- Proposed: 2026-09-05
- Depends on: R3 release gate and #83 physical-client QA.

