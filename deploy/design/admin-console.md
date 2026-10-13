# Admin console: tenant management, usage and monitoring

Status: proposed
Date: 2026-08-15
Role: ARCHITECT
Extends: `rbac.json` (BL-031), `session-strategy.json` (BL-034), `entitlements.json` (BL-023)

---

## 0. The blocker nobody has hit yet: the data does not exist

A dashboard cannot show what was never recorded, and today jobby records almost none of it:

- **There is no user table.** Auth.js runs with no adapter, so nothing anywhere states that an
  account exists. A `tenantId` is derived by hashing provider and subject, and a tenant
  "exists" only as a directory that appears the first time someone signs in.
- **There is no database at all.** No `pg`, `prisma`, `drizzle` or `sqlite` in
  `web/package.json` — the whole product is files plus Redis.
- **Usage is displayed but not kept.** `/api/run` totals tokens and cost per run and streams
  them to the browser (`send({ type: "done", tokens, costUsd })`), but the persisted run
  snapshot keeps id, kind and finished state. Once the run window closes, "how much did this
  tenant spend this month" is unanswerable.

So the console is downstream of a small data layer, and this is the point where jobby gets
its first database. That is not scope creep — the same tenant registry is already required by
invite codes (BL-033), plans (BL-023) and the per-tenant session version (BL-034).

**The sequencing that matters: start recording before the alpha opens, even if the console
lands later.** You cannot reconstruct events you did not write down, and alpha week one is
exactly the data you will want when pricing the paid tier.

## 1. The line that must hold

You asked to trace tenants and watch their usage. That is legitimate and necessary. It also
runs straight into the promise the product makes, so the boundary needs to be explicit:

> **Observe the shape of usage. Never the substance of the job search.**

| Shown in the console | Never in the console |
|---|---|
| Tenant id, created, last active, cohort, plan | `cv.md` content, any CV text |
| Key attached: provider, last 4, last used | The key itself |
| Counts: searches, scores, PDFs, CV saves | Which companies or roles they are pursuing |
| Per run: kind, engine, duration, tokens, cost, outcome | Report bodies, prompts, model output |
| Failures and error classes | Chat transcripts, application answers |
| Storage used, queue position | Tracker rows, saved searches |

This is not only an ethics point. The product's selling line is that a tenant's files never
leave their tenant; an admin screen that renders someone's CV makes that false, and a single
screenshot of it would end the trust the alpha is meant to build. Job-search data also
carries real-world consequence — it implies someone is leaving their employer.

`rbac.json` already states the rule: **admin never implies tenant file reads.** The console
is where that rule gets tested, so it is the console that must enforce it. Where support
genuinely needs to see content, use the escape hatch already decided — an explicit,
time-boxed, audited impersonation grant that the tenant can see — never a permission bit.

## 2. What to record

Two stores, both small.

**Tenant registry** (the first database table):

```
tenants(tenant_id PK, provider, created_at, last_seen_at, cohort, plan,
        status /* active | suspended */, session_version, storage_bytes)
tenant_keys(tenant_id, provider, last4, created_at, last_used_at, key_version)
```

**Usage events**, append-only, one row per meaningful action:

```
usage_events(id, tenant_id, at, kind /* search | score | pdf | cv_save | cv_chat */,
             engine, duration_ms, tokens, cost_usd, outcome /* ok | failed | cancelled */,
             error_class)
```

No job URLs, no company names, no prompt or output text — the schema itself enforces the
boundary in section 1, which is better than trusting a query not to select the wrong column.

Rolling counters stay in Redis for the live view; the event table is the durable record that
answers questions weeks later.

## 3. The screens

1. **Overview** — signups today and this week, active tenants, runs, failure rate, queue
   depth, total spend.
2. **Tenants** — sortable table: id, cohort, created, last active, key attached, runs in 7
   days, spend in 7 days, storage. Searchable by tenant id.
3. **Tenant detail** — the timeline you asked for: every run with kind, engine, duration,
   tokens, cost and outcome, plus lifecycle events (signed up, first search, key attached,
   first score, day-7 return) and key status. No content, anywhere on this page.
4. **Runs** — cross-tenant job list, filterable to failures, with the queue's own state.
5. **Errors** — grouped by class rather than a log tail, so a pattern is visible.

## 4. Actions, which is what makes it management rather than charts

- **Suspend / reactivate** a tenant
- **Revoke all sessions** — this is the session-version bump from BL-034, and the console is
  its natural home
- **Remove or rotate** a stored provider key
- **Retry or cancel** a queued job
- **Grant time-boxed impersonation**, recorded and visible to the tenant

Every action writes an audit row: who did it, to which tenant, when, and why. Views of a
tenant detail page are audited too — if you ever need to prove nobody browsed customer data,
only a log can do that.

## 5. Build it in-app; do not reach for Grafana yet

**In-app `/admin` in the existing Next app** is the right home. It reuses the Auth.js session
and the `admin` role, it can perform the actions above, and it can enforce the content
boundary in code. Grafana cannot suspend a tenant or revoke a session.

**Grafana and Prometheus are the right tools for the wrong half of this problem.** They are
excellent for infrastructure time-series and alerting, and useless for per-tenant drill-down
with actions. For a twenty-user alpha they would add a second service, a second auth surface
and another thing to keep patched, while Railway already exposes service metrics. Revisit
when infrastructure alerting genuinely matters — not for tenant administration, which will
never move there.

## 6. Securing the console itself

The console is the highest-value target in the product: it lists every tenant and can revoke
their access.

- The role check runs **server-side on every admin route**. Hiding the nav item is not a gate.
- Tenant ids must not be guessable into access — the check is on the session's role, never on
  a path parameter.
- No tenant content is rendered, so a compromised admin session leaks metadata, not CVs. That
  is the main reason section 1 is a security control and not just a policy.
- Destructive actions (suspend, revoke, impersonate) require re-authentication.
- Admin routes get their own rate limits and their own audit stream.

## 7. Order of work

1. **BL-035 — tenant registry and usage events.** Ship before the alpha opens; the console can
   follow, but the recording cannot be backfilled.
2. **BL-036 — the console**: overview, tenants, tenant detail, runs, errors.
3. **BL-037 — admin actions and audit**: suspend, revoke sessions, key removal, impersonation
   grants, with every action and every detail view logged.

None of this precedes **BL-021**. Key custody is still the gate before anyone is invited; a
dashboard that monitors a system leaking API keys is a dashboard with a good view of a fire.
