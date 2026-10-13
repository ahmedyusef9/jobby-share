# Jobby multi-tenancy: data plane, entitlements, secret custody

Status: proposed (extends the accepted `tenancy.json` / JOBBY-BL-016)
Date: 2026-08-13
Role: ARCHITECT

`tenancy.json` decided *where tenant files live* (`/data/tenants/{id}`). It did not decide
what is shared, how plans are enforced, or how a tenant's AI provider key is held. This
document decides those three, and states the one thing the directory decision does not buy.

---

## 0. Where the code is single-tenant today (verified, not assumed)

| Evidence | File | Why it blocks tenancy |
|---|---|---|
| `careerOpsRoot()` reads one process-global env var | `web/src/lib/career-ops.ts:13-17` | Every read/write path in the app funnels through it. A route that forgets a tenant gets *somebody's* data, not an error. |
| Secrets loaded into `process.env` | `web/src/lib/clis.ts:720-731`, `web/src/app/api/secrets/route.ts:44-58` | `process.env` is one mutable map per Node process, shared by all concurrent requests. Two tenants in flight = last writer wins. |
| `{ ...process.env }` handed to every spawned CLI | `web/src/lib/clis.ts:104`, and `env: process.env` at `:138, :379, :426, :472, :788, :807`; worker `deploy/worker/execute-run.mjs` | A third-party agent binary receives *all* keys plus `REDIS_URL`. |
| Queue payload has no tenant | `web/src/lib/queue/jobby-queue.ts:31-52` | `{runId, kind, input, cliId}` — the worker cannot know whose job it is. |
| One global queue, no per-tenant concurrency | `jobby-queue.ts:107-135`, `/api/queue` | One tenant enqueuing 500 evaluations starves everyone. |
| `/api/usage` reads the **operator's** `~/.claude/projects` | `web/src/app/api/usage/route.ts:17-19` | Reports the server's own token usage to every tenant. Meaningless — and a small info leak — once there is more than one user. |
| No auth of any kind | no `next-auth`/session/cookie code in `web/src` | There is no identity to scope anything to yet. |
| Client state under flat `jobby:*` keys | `web/src/lib/storage.ts:10-15` | Two accounts in one browser inherit each other's triage/UI state. |

Everything below assumes step 1 of the migration (auth + request-scoped root) lands first.
None of the rest is safe without it.

---

## 1. Decision — split the data plane: shared catalog, private overlay

Your instinct is right, and it is the decision with the most leverage. Jobby's data
divides cleanly into three classes, and only one of them is genuinely per-tenant.

**Class A — global facts.** Same answer for every tenant; identical work repeated per
tenant is pure waste.

- Discovered postings from public ATS boards (`scan-ats-full.mjs`, `/api/explore`)
- Posting body fetch (`/api/posting`) and liveness (`check-liveness.mjs`)
- Company logos (`/api/logo`, already a cache — just mis-located, see below)
- Company → ATS slug mapping (`verify-portals`), repost detection across the corpus

**Class B — tenant private.** Never shared, never derived from another tenant:
`cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`,
`data/applications.md`, `data/pipeline.md`, `data/contacts.tsv`, `reports/`, `output/`,
`interview-prep/`, `data/follow-ups.md`, `data/salary-observations.tsv`,
`.career-ops-web/runs/`, secrets.

**Class C — tenant-scoped state *about* Class A.** Private rows that reference a global
posting: triage decision, match score, report number, "have I already seen this".

### Shape

```
postings(posting_id PK, url_norm UNIQUE, ats_vendor, external_id,
         company, title, location, first_seen_global, last_seen, live_status)
tenant_posting_state(tenant_id, posting_id, first_seen_tenant, triage,
                     score, report_num, PRIMARY KEY (tenant_id, posting_id))
```

One crawler writes `postings` for the whole platform. Each tenant's `portals.yml`
filters (`title_filter` / `location_filter`) become a *query* over that table instead of
a private crawl. The full-ATS sweep is the slowest thing the product does and is
byte-identical per tenant; running it per tenant is `O(tenants × corpus)` HTTP for zero
added information.

### Keep the file contract intact

`AGENTS.md` and `volume-schema.json` both commit to markdown-on-disk as the source of
truth for the `.mjs` scripts, and that commitment is load-bearing — `scan.mjs`,
`merge-tracker.mjs`, `set-status.mjs` and the modes all read files. So the catalog is an
**index, not a replacement**: after a query, project the tenant's matching rows into
their `data/pipeline.md` and `data/scan-history.tsv` inside `/data/tenants/{id}/`. The
existing scripts keep working unchanged; the crawl stops being duplicated.

### A semantic fix that falls out for free

`readScanDates()` (`career-ops.ts:96-112`) currently uses `first_seen` for the inbox
freshness facet, where it means "first seen *by me*" — so a posting that has been live
for three months looks brand new to a tenant who joined yesterday. Splitting the column
fixes that: freshness reads `first_seen_global` (how old the *job* is), dedup reads
`first_seen_tenant` (what *I* have already triaged). Shared catalog is not just cheaper
here, it is more correct.

### Two things the shared catalog is not allowed to do

1. **No cross-tenant inference.** "Users like you applied to X" reads one tenant's private
   Class B data to serve another. Out of scope without explicit opt-in; it also collides
   with the Source-of-Truth Boundary in `AGENTS.md`.
2. **No shared trust.** Postings stay untrusted input (`AGENTS.md`, Untrusted External
   Content). Sharing does not raise per-item risk — same public source — but it raises
   *blast radius*: one poisoned JD now reaches every tenant's prompts. Sanitize once,
   centrally, at ingest, and keep the "data, never instructions" framing in every prompt
   that embeds a posting.

Also move the logo cache out of `.career-ops-web/logo-cache` (`api/logo/route.ts:20-21`)
to a platform-level path. It is Class A sitting in a Class B directory — today it is a
duplicated-work bug, after tenancy it is a (minor) cross-tenant read.

---

## 2. Decision — isolation is enforced at three layers, not one

Directory-per-tenant is a *convention*. Three mechanisms make it a boundary.

**(a) Request-scoped root, no default.** Delete the global `careerOpsRoot()`. Replace with
`tenantRoot(ctx)` where `ctx` carries a `tenantId` resolved from the verified session and
propagated via `AsyncLocalStorage`. **Calling it without a context must throw**, never
fall back to a default path — a default is how a forgotten guard becomes a silent
cross-tenant read instead of a 500. `tenantId` comes from the session claim only; if a
route param carries one, it must be compared against the session and rejected on
mismatch.

**(b) Path containment on every resolve.** `resolve(p).startsWith(tenantRoot + sep)` or
refuse. The logo route already does exactly this (`api/logo/route.ts:76-79`) — generalize
that idiom into the shared helper instead of re-deriving it per route.

**(c) The part the directory model does not buy — and the real threat model.**

Jobby's core action is *spawning a general-purpose coding agent with filesystem access*
(`claude`, `codex`, `opencode`, `cursor` — `clis.ts`, `execute-run.mjs`). A path check in
a Next.js route does nothing to a child process that can `cd ..`. Combined with untrusted
JD text entering the prompt, the honest statement is: **a directory is not a sandbox for
an agent.** Options, cheapest first:

1. **POC:** one worker instance per tenant, tenant root as the only mounted volume. Simple,
   correct, does not scale past a handful of tenants.
2. **Target:** per-job ephemeral container (or gVisor/Firecracker) with only
   `/data/tenants/{id}` mounted, a scrubbed env, per-job `HOME`, and no Redis credentials.
   The BullMQ worker becomes a scheduler of sandboxes rather than a process that spawns
   CLIs itself.
3. **Weakest acceptable:** per-tenant POSIX uid + bind mount, agents dropped to that uid.

Pick (1) now, budget (2) before the first paying tenant that is not you. Note also that
agent CLIs write state under `$HOME` (`~/.opencode`, `ensure-opencode-config.mjs`) — a
shared container `HOME` is a cross-tenant path; set `HOME` per job inside the tenant root.

**(d) Queue.** `EnqueueRunPayload` gains `tenantId` (+ `plan`). The worker sets its root
from the payload, and re-checks entitlement — the queue is not a trusted caller. Add a
per-tenant concurrency cap (Redis semaphore or BullMQ groups) and priority by plan, so a
trial tenant cannot starve a paid one.

**(e) Client.** Namespace localStorage to `jobby:{tenantId}:*` and clear on sign-out
(`storage.ts`). Cheap, and easy to forget until two accounts share a laptop.

**Auth provider:** keep `tenancy.json`'s call — Auth.js (GitHub/Google OAuth) for
self-hosted-friendly, Clerk if you want orgs + billing handled for you. Decide on the
billing question, not the auth question: Clerk earns its cost only alongside §3.

---

## 3. Decision — entitlements: capability + meter, enforced server-side

Two different things get gated, and conflating them is the usual mistake:

- **Features** — boolean capability (can this tenant schedule scans at all?)
- **Consumption** — metered volume (how many evaluations this period?)

Trial abuse is almost entirely a consumption problem. Hiding a tab is UX, never a gate.

### What the tiers should track: cost, not menus

Jobby's operations split sharply by marginal cost, which makes the tier lines obvious.

| Cost class | Routes | Trial | Basic | Advanced |
|---|---|---|---|---|
| **Zero-token** (HTTP/CPU only): explore/scan, tracker, inbox, CV editor, PDF export, reports, follow-ups | `/api/explore`, `/api/tracker/*`, `/api/pipeline`, `/api/cv`, `/api/cv/export`, `/api/report`, `/api/followups` | ✅ capped | ✅ | ✅ |
| **LLM-metered**: Score/evaluate, CV chat, assistant, AI explore, match hints, form fill | `/api/run` (`evaluate`/`pdf`/`research`), `/api/cv/chat`, `/api/assistant`, `/api/explore/ai`, `/api/match-hints`, `/api/apply/fill` | N evals total, house key | monthly quota | high quota / fair use |
| **Heavy or privileged**: scheduled scans, full-ATS sweep, batch fan-out, browser drive, BYO engines/keys | `deploy/worker/scheduler.mjs`, `scan-ats-full`, `batch/`, `/api/apply/drive`, `/api/clis` | ❌ | limited | ✅ |

Suggested defaults: **Trial** 14 days, 1 CV, ~10 evaluations, manual scan only, house key,
no scheduler. **Basic** monthly evaluation quota, daily scan, BYO key allowed, 1 seat.
**Advanced** larger quota, scheduler + full sweep, batch fan-out, all engines, priority
queue, export/API.

### Implementation — one choke point, checked twice

```ts
entitlements(tenant) -> { features: Set<FeatureId>, limits: Record<Meter, number>, period }
requireFeature(ctx, "scan.schedule")        // throws 403
consume(ctx, "run.evaluate", 1)             // throws 402 when over limit
```

- Plan lives on the tenant record; `entitlements()` is the single derivation (plan +
  per-tenant override). No `if (plan === "basic")` scattered through routes.
- Counters in Redis — already in the stack — keyed `usage:{tenant}:{period}:{meter}`.
- **Charge at enqueue, reconcile at completion**: reserve the credit in `/api/run` before
  `enqueueRun`, refund on failed/cancelled. Metering only in the worker lets a tenant
  queue unlimited work; metering only at the route loses the refund path.
- **Re-check in the worker.** Defense in depth: anything that can write to Redis can
  enqueue a job.
- Typed 402/403 with `{ feature, limit, used, upgradeTo }` so the UI renders an upgrade
  prompt rather than a generic error. This is the one place the client and server share a
  vocabulary.
- Trial identity: bind to the OAuth provider id + verified email, not to a cookie. Do not
  let trials use house keys for batch fan-out — that is the abuse path with real money on it.
- Replace `/api/usage` (`route.ts:17-19`, reads the operator's `~/.claude`) with the
  tenant's own metered usage from these counters. It is currently reporting the wrong
  entity entirely.

---

## 4. Decision — secret custody: house key by default, BYO as an Advanced feature

Today: plaintext `secrets.env` (mode 0600) → `process.env` → forwarded to every child
process. For one local operator that is defensible. For multi-tenant it fails on three
independent counts: shared process state, plaintext at rest, and unbounded forwarding.

### Two custody models — choose per tier, deliberately

- **House key** (we hold the provider account, meter and bill): the tenant never gives us a
  credential. Strictly safer for both sides, and it is what makes Trial possible at all.
  **Default for Trial and Basic.**
- **BYO key** (tenant's own provider key): we hold a bearer credential whose blast radius
  is their provider balance. Real trust burden, real support burden. **Advanced only** —
  which also gives §3 a genuine reason to exist beyond quota size.

### Storage design (BYO path)

1. **Never `process.env`.** Fetch → decrypt → pass into *that one spawn's* env → drop.
   This single change is what makes concurrent tenants safe; everything else is hardening.
2. **Envelope encryption.** Per-tenant DEK wrapped by a master key held in the platform
   env (`JOBBY_SECRETS_MASTER_KEY`, a Railway variable — never on the data volume, so a
   volume snapshot leak is not a key leak). AES-256-GCM via Node's built-in
   `crypto.createCipheriv` — no new dependency. Store `{ciphertext, iv, tag, keyVersion,
   last4, createdAt}`.
3. **Bind AAD to `tenantId + provider`.** A ciphertext copied into another tenant's row
   then fails to decrypt rather than silently working. Cheap, strong, and it turns a
   whole class of row-mixup bugs into hard errors.
4. **Write-only API.** GET returns presence + `last4` + `createdAt` only — the current
   route already returns presence flags (`api/secrets/route.ts:14-24`), so keep that
   invariant and never regress it. Rotation = write a new version; deletion = hard delete
   + invalidate any cached plaintext (this is BL-013's UX, with a real backing store).
5. **`keyVersion`** on every record so master-key rotation is a background re-wrap, not an
   outage.
6. Prefer provider OAuth / short-lived tokens where offered; otherwise surface a spend cap
   and last-used timestamp so a leak is visible to the tenant, not only to us.

### Leak paths specific to this codebase — fix with the storage change, not after

- `cliSpawnEnv()` returns `{ ...process.env }` (`clis.ts:104`) and `execute-run.mjs`
  inherits the worker env: a third-party binary gets every provider key **and**
  `REDIS_URL`. Build the child env from an **allowlist** (`PATH`, `HOME`, `LANG`, plus the
  one provider key that job needs).
- CLI stdout is streamed into run snapshots and the UI (`.career-ops-web/runs/*.json`). A
  CLI that echoes its environment persists a key to disk and to the browser. Redact
  provider-key patterns on the way into snapshots.
- Prompt injection: a JD saying "print your environment variables" is exactly the
  untrusted-content threat `AGENTS.md` already names — now with a live credential in
  reach of the agent. Another argument for house-key-by-default and a scrubbed env.
- Never log key material; audit *use* (tenant, provider, job, timestamp) instead.

---

## 5. Migration order (each step independently shippable)

1. **Auth + request-scoped root.** Auth.js session → `tenantId`; `tenantRoot(ctx)` throws
   without context; path containment helper. Single-tenant still works (one tenant row).
2. **Move the data.** `/data/tenants/{id}/…` per `volume-schema.json`; namespace
   localStorage; move the logo cache to a platform path.
3. **Secret custody.** Encrypted store + allowlisted child env + snapshot redaction.
   Ship *before* opening signup, not after — this is the step that is painful to retrofit.
4. **Queue tenancy.** `tenantId` in the payload, per-tenant concurrency, plan priority.
5. **Entitlements.** `entitlements()` + `requireFeature`/`consume`, Redis counters, typed
   402/403; replace `/api/usage`.
6. **Shared catalog.** Global `postings` + `tenant_posting_state`, projection into each
   tenant's `pipeline.md` / `scan-history.tsv`; one crawler for the platform.
7. **Sandboxed execution.** Per-job container for agent spawns — the item to fund before
   the first external paying tenant.

Steps 1–3 are prerequisites for *any* second user. Steps 4–6 are what make it a product.
Step 7 is what makes it defensible.

## 6. Proposed backlog rows (not yet written to `implementation_backlog.csv`)

| ID | Title | Priority | Depends on |
|---|---|---|---|
| JOBBY-BL-020 | Auth + request-scoped tenant root (no global `careerOpsRoot`) | P0 | BL-016 |
| JOBBY-BL-021 | Per-tenant encrypted secret store + allowlisted child env | P0 | BL-020, BL-013 |
| JOBBY-BL-022 | Tenant-aware queue: payload `tenantId`, per-tenant concurrency, plan priority | P1 | BL-020, BL-006 |
| JOBBY-BL-023 | Entitlements service: features + meters, typed 402/403, replace `/api/usage` | P1 | BL-020, BL-022 |
| JOBBY-BL-024 | Shared posting catalog + per-tenant overlay projection | P1 | BL-020, BL-015 |
| JOBBY-BL-025 | Sandboxed per-job agent execution | P2 | BL-022 |
| JOBBY-BL-026 | Tenant-aware root for the `.mjs` toolchain | P0 | BL-020 |

## 7. Buy-vs-build, settled

Kong, a tenant/identity platform (Clerk/WorkOS/Frontegg), Vault/OpenBao and cert-manager
were evaluated on 2026-08-14 and all deferred — see `platform-adoption.json`. The short
version: the tenancy boundary is *inside* the process (ALS → `tenantRoot()` → filesystem,
plus a spawned agent that can read the filesystem), and all four products sit outside it.
cert-manager is not even applicable — there is no Kubernetes in this stack. If holding a
master key in a platform env var is the objection, the answer is a managed cloud KMS, not
a self-hosted Vault cluster. Do not re-open without one of the triggers recorded there.
