# Jobby System Contract

The constitution. Everything below is settled unless a decision in `DECISIONS.md`
supersedes it. An agent that finds code disagreeing with this file fixes the code —
it does not ask which one is right.

## What jobby is

A multi-tenant job-search **workspace**, not a scoring farm. A fork of career-ops:
the CLI toolchain stays the engine for files; the web app and the MCP server are
the product surface.

For the 10-account release a person can:

1. **Resume** — upload or paste, keep `cv.md` current, download it.
2. **Explore** — scrape jobs with query, country, distance, and the boards that
   already work (ATS directories + Drushim + LinkedIn/JobSpy).
3. **Pipeline** — save, list, update, and drop jobs. No host-side A–F evaluation.
4. **Rules and export** — house rules (`modes/_custom.md`) and a take-your-data zip.
5. **MCP** — the same five, from ChatGPT / Claude / Cursor, against that tenant.

Evaluation, when they want it, runs **on their side** with their own ChatGPT or
Claude subscription via MCP. Jobby does not enqueue member Score onto BullMQ.

## Release

`0.4.0-alpha`. The goal is not scale. The goal is: ten real people use it, and we
learn what they actually need.

## Tenancy

```
identity  →  account  →  tenant  →  directory
(a login)   (a person)  (a random  (career-ops
                          stable id) working tree)
```

One account owns exactly one tenant. No organizations, no teams, no projects, no
hierarchy. The tenant id is random, never derived from the login.

## Where state lives

| State | Home | Why |
|---|---|---|
| Identity, account, role, plan, status, session version | **Appwrite** | queryable, shared across instances, survives a container |
| Batches, capacity, app config versions, usage events, job events | **Appwrite** | operator changes these at runtime; job events are metadata only |
| MCP API keys (hashed) | **Appwrite** | up to 5 named live keys per tenant; the secret is shown once |
| Canonical job postings | **Appwrite** (global, not tenant-scoped) | one row per real posting, shared by everyone |
| Search profiles, matches, evaluations, feedback | **Appwrite**, tenant-scoped | derived from a person; never shared |
| Tenant working files: `cv.md`, `reports/`, `data/`, `output/` | **filesystem** `tenants/{id}/` | spawned CLI agents need a real directory |
| Provider API keys | encrypted at rest, per tenant | the cipher is the boundary, not the code path |

Runtime configuration is never hardcoded and never in `.env`. If a human changes
it without shipping code, it is a database row.

## Access

- **Registration is open** while capacity allows. No invite codes, no invitation
  emails, no allow-list, no operator approval.
- Capacity is a number the operator raises at runtime.
- Two roles: `operator` and `member`. Not a permission graph.
- Role, plan and tenant isolation are three separate questions and never collapse.

## Money

The operator pays for the host — CPU, bandwidth, storage. The operator pays for
**no model usage but their own**. Every LLM call spends the caller's own
subscription (MCP → ChatGPT/Claude) or their own stored key. Jobby never funds a
member's tokens.

Job discovery spends no tokens, but it **does** spend the host. That is why it
is metered:

| Plan | Price | Daily scans | Daily MCP calls | Results / source |
|---|---|---|---|---|
| `free` | $0 | 3 | 40 | 40 |
| `basic` | $5 | 8 | 120 | 80 |
| `plus` | $10 | 15 | 250 | 150 |
| `advanced` | $20 | 30 | 500 | 250 |
| `alpha` | unpaid cohort | same as `advanced` | same | same |

Stripe does not ship in 0.4.0. The operator assigns the plan. The ten friendly
accounts stay `alpha` and get the $20 quota without paying.

## MCP

Connect is a URL with one secret:

`{origin}/api/mcp?key=jb_…`

The same secret is accepted as `Authorization: Bearer`. Tenant is taken from the
key, never from a query `tenantId`. A leaked key is that tenant's data until it
is revoked. An account may hold up to five named live keys (e.g. ChatGPT +
Cursor); **Add key** keeps existing keys, **Rotate all** retires them first.

MCP is the product API for resume, explore, pipeline, jobs, rules, and export.
It is not a public app and it has no Score-commit tool on the host.

## Critical invariants

1. A request can only ever reach its own tenant's data — **and neither can the
   browser**: localStorage is scoped per tenant, and no account inherits what the
   previous occupant of that browser left behind.
2. A member can never spend the operator's credentials.
3. The same real job posting exists once, globally.
4. A match and its evaluation belong to one tenant.
5. Scanning is idempotent: running it twice does not duplicate anything.
6. Progress is computed from emitted events, never from a model's claim about
   itself.
7. Security gates fail closed. "I don't know who this is" resolves to *no
   privileges*, never to operator.
8. Capacity, quota and seat limits are enforced by a database mutex, never by
   read-then-write.
9. A job is not succeeded until the dispatcher has verified its artifacts on
   disk. A model `VERDICT` line is not completion.
10. Spawned agents run in a per-job sandbox: that tenant's directory, a private
    `HOME`, that tenant's provider key. They do not receive Redis, Appwrite, or
    Docker credentials, and they cannot read another tenant's files.
11. Member Score does not run on this host. PDF export may. Operator Score may.

## Out of scope for 0.4.0

Organizations, teams, SSO, Stripe checkout, paid referrals, community features,
Terraform, host-side member evaluation. The model has room for them; none of
them ship in this release.
