# Jobby multi-tenant — PRD (scan version)

**Release** 0.4.0-alpha · **Audience** operator, reviewers · **Rule** the code wins; where this
disagrees with the code, this is the bug.

**How to read:** every claim has a `verify at` cell — open that file at that line and check it.
Paths are from the repo root. Prose version of the same content: git history of this file.

**The whole model in one line:**

> A **release** opens a **batch** → a batch has a **capacity** → anyone may register while
> there is room → an account owns a **tenant** → a tenant is a **directory**.
> Nothing crosses a tenant boundary.

**Registration is open.** No invite codes, no invitation emails, no allow-list, no operator
approval. The only gate is capacity, and capacity is a number you change at runtime.

---

## A · Why any of this exists

| Old assumption | Breaks how, with 10 people | Fixed by |
|---|---|---|
| Files live in the project root | One CV, one tracker, one report set, shared | Tenant directories (§C) |
| API key in `.env` | First key saved wins; everyone's jobs spend it | Per-tenant key store (§F) |
| Guest list in `AUTH_ALLOWED_EMAILS` | Admitting someone = edit file + restart | Open signup, runtime capacity (§D) |
| Everyone signing in is the operator | Any tester reaches the admin console | Role gate (§B, §G) |
| Config baked into the image | Closing signups = rebuild + deploy | Live config versions (§I) |
| Nothing is counted | 10 testers become 40; you learn it from the bill | Capacity slots (§D) |

---

## B · Three concerns that are NOT the same thing

| Concern | Question | Values | Enforced at |
|---|---|---|---|
| **Isolation** | *Whose data?* | tenant id | `web/src/lib/tenant/http.ts:33` |
| **Role** | *What kind of user?* | `operator` · `member` | `scripts/entitlements.mjs:19-24, 87` |
| **Plan** | *How much may they do?* | `alpha` · `free` · `basic` · `advanced` | `scripts/entitlements.mjs:26-33, 63-68` |

Operator is **not** the top plan — it bypasses plan gating entirely (`entitlements.mjs:87`).
Collapsing the two means you cannot sell a full plan without giving away the admin console.

---

## C · Vocabulary — four nouns, never merged

```
identity  →  account  →  tenant  →  directory
(a login)   (a person)  (an id)   (files on disk)
```

| Noun | Is | Example | Verify at |
|---|---|---|---|
| Identity | a way to sign in; one person may hold several | `email:6a8f…`, `github:12345` | `scripts/accounts.mjs:174` |
| Account | the person: status, role, plan, session version | `acct_9f3c…` | `scripts/accounts.mjs:216, 250` |
| Tenant | the address of the data — **random, not derived from the login** | `t_<tenant>` | `scripts/accounts.mjs:217` |
| Directory | a full career-ops working tree | `{platformRoot}/tenants/{id}/` | `scripts/resolve-root.mjs:61` |

> **The one decision that could not have been undone:** the tenant id is `crypto.randomBytes(8)`,
> not `sha256(provider:subject)`. Derived ids mean GitHub + Google = two tenants, two CVs, no
> merge path — and a lost login = an unreachable directory. Random id + index = you can change
> how you sign in and your data does not move. `scripts/accounts.mjs:216-217`

**Why not put everything in Appwrite:** the CLI agents jobby spawns need a real working directory
on a real filesystem. Appwrite holds identity, capacity, config. The filesystem holds work.

---

## D · Flow 1 — Signup (`POST /api/signup`) — **open registration**

| # | Gate | Fails with | Verify at |
|---|---|---|---|
| 1 | Route reachable without a session | — (allowlisted) | `web/src/proxy.ts:9-15` |
| 2 | Email auth configured on this instance | `404` | `api/signup/route.ts:21` |
| 3 | Instance is multi-tenant | `403` | `api/signup/route.ts:24` |
| 4 | **Live config** says `signupOpen` | `403` | `api/signup/route.ts:36` |
| 5 | Valid email + min password length | `400` | `api/signup/route.ts:47-60` |
| 6 | **Is there room?** — round open and under capacity | `403` + a sentence | `api/signup/route.ts:66` |
| 7 | **Take the capacity slot — before creating anything** | `403` if it filled up | `api/signup/route.ts:88` |
| 8 | Create the identity in Appwrite | `409`/`400` → slot released | `api/signup/route.ts:101-106` |
| 9 | Bind the slot to the real account id | — | `api/signup/route.ts:110` |

Paths are relative to `web/src/app/`. **No session is issued here** — the tenant is created on
first sign-in, so there is exactly one place where accounts come into being.

> **Nothing in this flow asks who the applicant is.** There is no invite code, no invitation
> email, no allow-list and no operator approval. Step 6 asks only whether the round is
> accepting people and whether it has room. Capacity control, not invitation control.

**Why take the slot before creating (step 7 before 8):** the obvious order leaves an orphan —
the loser of a race has a *working Appwrite user with no slot*, who can sign in and get a
tenant, putting the round over its limit. Claiming first means a lost race costs nothing.
`api/signup/route.ts:78-87`

**The claim is a real mutex, not check-then-write:** it creates a document whose id is
`{batchId}#{index}`; ids are unique, so the create either succeeds or `409`s — the database
decides, not two web processes both reading `claimed < capacity` a millisecond apart. On a
409 it tries the next index, so two people with room to spare both get in.
`scripts/batch-store.mjs:100-129` · race test: `tests/batch-store.test.mjs`

**Refusal messages** (every one is prose a person can act on):

| Situation | What they read | Verify at |
|---|---|---|
| Round full | *"Jobby is currently full. We are testing this release with a limited number of people. Please check back soon for the next round."* | `release-state.mjs:131` |
| Round not opened yet | *"This round has not opened yet."* | `release-state.mjs:155` |
| Round closed | *"This testing round has closed."* | `release-state.mjs:158` |
| Already registered | *"You already have an account. Signing in instead…"* | `signin-form.tsx` (on 409) |

"Full" is also what somebody sees when the batch has already flipped to `full` and there is no
open batch left to evaluate — the code looks for a full round rather than falling back to a
flat "sign-ups are not open", which would sound permanent. `batch-store.mjs:66-77`

---

## E · Flow 2 — Sign-in and tenant birth

| # | Step | Note | Verify at |
|---|---|---|---|
| 1 | Appwrite verifies the password | Appwrite owns the credential; Auth.js owns the session | `web/src/auth.ts:105-124` |
| 2 | **Gate runs before a session exists** | a refusal here blocks sign-in, not just a page | `web/src/auth.ts:193-224` |
| 2a | Email accounts: does this identity hold a **capacity slot**? | second, independent check on the orphan hole | `web/src/auth.ts:199-208` |
| 2b | Is the account `active`? | suspended/deleting cannot re-provision itself | `web/src/auth.ts:216-223` |
| 3 | Account created, tenant provisioned, directory seeded | role `member`, plan from config | `scripts/accounts.mjs:174, 128` |
| 4 | JWT cookie issued with `tenantId` + `sv` | no DB adapter; JWT strategy | `web/src/auth.ts:168-185` |
| 5 | Every later request pinned to that tenant | a handler never names a tenant | `web/src/lib/tenant/http.ts:33` |

**Session version (`sv`) — why it exists:** JWTs stay valid until they expire, wanted or not. The
token carries `sv`; the account carries the current one. Bump it and **every live session for that
account dies on its next request** — which is what makes "suspend" mean *now* instead of *within
seven days*. `scripts/accounts.mjs:359` · verified live.

---

## F · Flow 3 — API keys (the most security-sensitive path)

**The bug this replaced:** the old endpoint wrote keys into `process.env` — one object shared by
every request in the Node process. First tenant to save won the global slot; everyone else's jobs
silently spent it. Not a leak of the key text — a leak of the *money*.

| Property | Value | Verify at |
|---|---|---|
| Scheme | envelope: per-tenant DEK, wrapped by master KEK | `scripts/key-store.mjs:11-20` |
| Cipher | AES-256-GCM | `scripts/key-store.mjs:36` |
| **AAD binding** | `jobby\|v1\|{tenantId}\|{envKey}` | `scripts/key-store.mjs:17, 156` |
| At rest | `{tenant}/.career-ops-web/provider-keys.json`, mode `0600` | `scripts/key-store.mjs:15` |
| Production without a master key | **refuses to start** | `scripts/key-store.mjs:121` |
| Secrets in child processes | only from the tenant store, never the server env | `scripts/key-store.mjs:51-64` |
| Swap-out seam | `getKeyForJob(tenantId, provider)` + `JOBBY_KEY_BACKEND` | `scripts/key-store.mjs:364` |
| UI | `api/secrets/route.ts` — list / set / delete | `web/src/app/api/secrets/route.ts:29, 64, 70` |

> **The AAD line is the one that matters.** Copy a key blob into another tenant's directory and it
> does not decrypt into the wrong account — it **fails to decrypt**. Cryptography enforces the
> boundary, not a code path.

The seam is about *who wraps the DEK* (local cipher → OpenBao/Vault/KMS). Moving the file into
Appwrite is a **separate** migration; do not conflate them.

---

## G · Flow 4 — Doing work · plans × capabilities

| Capability | `alpha` | `free` | `basic` | `advanced` | Costs money |
|---|:--:|:--:|:--:|:--:|:--:|
| Search / scan jobs | ✅ | ✅ | ✅ | ✅ | no (zero-token) |
| Export data | ✅ | ✅ | ✅ | ✅ | no |
| Delete account | ✅ | ✅ | ✅ | ✅ | no |
| Manage own keys | ✅ | ✅ | ✅ | ✅ | no |
| **Score a job** | ✅ | ❌ | ✅ | ✅ | **yes** |
| **Generate a CV** | ✅ | ❌ | ✅ | ✅ | **yes** |
| **CV chat** | ✅ | ❌ | ❌ | ✅ | **yes** |
| Admin console | operator only — plan is irrelevant | | | | — |

`scripts/entitlements.mjs:52-68` · one gate: `can(account, capability)` at `:77-95`

| Rule | Verify at |
|---|---|
| Suspended account can do exactly one thing: **export** | `entitlements.mjs:81-83` |
| Status check runs **before** the operator bypass (a suspended operator stays suspended) | `entitlements.mjs:81 → 87` |
| Ending the POC = flip `defaultPlan` `alpha` → `free` for new accounts | `entitlements.mjs:109-112` |
| Members get **404** on `/admin`, not 403 (403 confirms the page exists) | `web/src/app/admin/page.tsx:12` |

---

## H · Flows 5–7 — Sign-out, operator levers, leaving

**Sign-out** clears the cookie. Touches nothing else — not the account, tenant, keys or capacity slot.
Signing back in returns to the same tenant, because the tenant was never derived from the session.

| Operator lever | Effect | Reversible | Verify at |
|---|---|---|---|
| **Suspend** | access stops immediately (`sv` bump); data stays; export still works | yes | `scripts/accounts.mjs:275` |
| **Change plan** | access narrows | yes | `scripts/accounts.mjs:314` |
| **Raise capacity** | 10 → 15; a full round reopens immediately | yes | `scripts/batch-store.mjs:235` |
| **Lower capacity** | stops new signups; **never evicts anybody** | yes | `scripts/batch-store.mjs:245-256` |
| **Close the round** | no new accounts; existing ones keep working | yes (→ open) | `release-state.mjs:58-64` |

| Leaving, step | Detail | Verify at |
|---|---|---|
| 1 · Export | whole tenant directory as a zip; works while suspended | `account-lifecycle.mjs:364` |
| 2 · Request deletion | confirm by typing your own email → status `deleting` | `account-lifecycle.mjs:142` · `api/account/delete/route.ts:38` |
| 3 · Grace period | `deletionGraceDays`, default **7**; restorable | `account-lifecycle.mjs:29, 175` |
| 4 · Purge | directory removed, identities forgotten | `account-lifecycle.mjs:201` · `accounts.mjs:293` |
| Path safety | containment check — a malformed id cannot escape `tenants/` | `account-lifecycle.mjs:60` |

A purged account's capacity slot is **not** freed automatically. Deleting an account does not
silently admit a stranger; if you want the place back, lower and raise the capacity yourself.

---

## I · Live config — changing the app without a deploy

| Property | Value | Verify at |
|---|---|---|
| Storage | one **immutable** row per version; exactly one `active` | `release-state.mjs:28-32` |
| Refresh | poll, compare version, **replace the whole frozen object** | `config-store.mjs:70` |
| TTL | 30 s (`JOBBY_CONFIG_TTL_MS`) | `config-store.mjs:33` |
| Concurrency | simultaneous refreshes collapse into one request | `config-store.mjs:70` |
| On Appwrite failure | serves **last known good**, never the defaults | `config-store.mjs:70` |
| Unknown keys | **rejected**, not ignored | `release-state.mjs:264-266` |
| Publish | `publishConfigVersion(version, value, notes)` | `config-store.mjs:162` |

**The seven settings — this list is the whole surface:**

| Setting | Default | Effect | Read by anything today? |
|---|---|---|---|
| `signupOpen` | `true` | closes registration everywhere in ≤30 s | ✅ `api/signup/route.ts:36` |
| `defaultPlan` | `alpha` | plan for newly provisioned accounts | ✅ `entitlements.mjs:109` |
| `maxAccounts` | `10` | default capacity for a **new** batch | ⚠️ the live limit is `capacity` on the batch row |
| `sessionMaxAgeDays` | `7` | session lifetime | ⚠️ not wired |
| `deletionGraceDays` | `7` | undo window on delete | ✅ `account-lifecycle.mjs:39` |
| `requireOwnApiKey` | `true` | tester must attach a key | ❌ **nothing reads it** |
| `feedbackUrl` | `""` | link shown to testers | ❌ not wired |

`scripts/release-state.mjs:234-242`

> **No secret and no endpoint is ever a config value.** Config that can change credentials is a
> privilege-escalation path wearing a settings page. `release-state.mjs:228-233`

**Where does a given setting belong?** Test: *does a human change this without shipping code?*

| Layer | Examples | Changed by |
|---|---|---|
| Infrastructure | ports, volumes, image tags | Compose / Terraform → a deploy |
| Schema | collections, attributes, indexes | Appwrite CLI → a migration |
| Runtime business state | who may sign up, plans, capacity | a database row → live |

---

## J · The state machines

Pure functions, no I/O — which is why they are exhaustively testable and why storage can move from
Appwrite to Postgres later. `scripts/release-state.mjs` · 22 tests.

**Config version** `release-state.mjs:66-72`

| From | May become | Note |
|---|---|---|
| `draft` | `active` | |
| `active` | `retired` | |
| `retired` | — | terminal; publish a copy instead of reactivating |

**Batch** `release-state.mjs:58-64`

| From | May become | Note |
|---|---|---|
| `draft` | `open`, `archived` | opening with 0 capacity is refused (`:110`) |
| `open` | `full`, `closed` | |
| `full` | `open`, `closed` | raising capacity **reopens** — "two more testers" is normal |
| `closed` | `open`, `archived` | |
| `archived` | — | terminal |

There is **no third machine.** A capacity slot has one state — it exists or it does not — because
open registration has nothing to track about a person before they arrive. The invite state machine
that used to sit here was deleted along with the invitations.

**Capacity accounting** (`release-state.mjs:124-129`): `taken` is a count of slot rows, so it is
derived from what exists rather than from a stored counter that can drift. The last claim moves the
batch to `full` in the same operation (`batch-store.mjs:137-144`), and raising the limit moves it
straight back to `open` (`batch-store.mjs:245-250`).

---

## K · What cannot happen

> **One deliberate exception, from §O:** the global job corpus is shared by design. It holds
> only what was already public on the employer's site. Everything derived from a person —
> their query, their score, their report, their CV — stays inside the tenant. See §P.

| Promise | Enforced by | Verify at |
|---|---|---|
| A request cannot read another tenant's files | tenant comes from the verified session | `lib/tenant/http.ts:33` |
| A stolen key blob cannot be replayed elsewhere | AAD binds ciphertext to tenant + var name | `key-store.mjs:17, 156` |
| One tenant's key cannot be spent by another | secrets only from the per-tenant store | `key-store.mjs:51-64` |
| A member cannot discover the admin console | `/admin` → **404** | `app/admin/page.tsx:12` |
| A suspended account cannot ride an old session | `sv` bump invalidates live tokens | `accounts.mjs:359` |
| Capacity cannot be exceeded, even under a race | slot taken before the identity exists; sign-in re-checks | `api/signup:88` · `auth.ts:207` |
| Two people cannot take the same last place | document-id mutex — the DB decides | `batch-store.mjs:108` |
| A settings page cannot escalate privilege | no secrets in config; unknown keys rejected | `release-state.mjs:228, 264` |
| Signups cannot silently reopen in an outage | last-known-good, not defaults | `config-store.mjs:70` |
| Public signup + shared-directory mode | **the app refuses to boot** | `auth.ts:134-140` |

---

## L · Status — what is actually true today

`✅ verified` = observed running · `✅ built` = written + tested, not yet exercised on the deployed
container · `❌` = does not exist.

| Area | Status | Evidence |
|---|---|---|
| Per-tenant encrypted key store | ✅ verified | operator holds a key; second tenant sees 4 unattached providers |
| Tenant isolation (`withTenant`) | ✅ verified | second tenant got its own directory `t_<tenant>` |
| Role/plan gate | ✅ verified | member → 404 on `/admin`; downgrade blocked scoring mid-session |
| Suspend kills a live session | ✅ verified | signed-in tester logged out on next request |
| Email signup + sign-in | ✅ **verified live** | signed in to a fresh tenant `t_<tenant>`; `/admin` → 404 for that member |
| Open signup, capacity slots, claim mutex | ✅ **verified live** | a brand-new address registered with no invite; slot `alpha-1_1` appeared |
| Release state machine | ✅ built | `tests/release-state.test.mjs` — 22 tests |
| Live config + version compare | ✅ built | gates `/api/signup` |
| Export / delete / grace / purge | ✅ built | `tests/accounts.test.mjs` — 13 tests |
| Capacity refusal and 10 → 15 | ✅ **verified live** | capacity 2 refused the next person with the full message; raising to 5 let the same person straight in |
| **Operator dashboard (capacity, accounts, config)** | ❌ **not built** | the biggest gap; `setCapacity` exists, no UI |
| OAuth takes a capacity slot (BL-045) | ❌ not built | GitHub/Google still read `AUTH_ALLOWED_EMAILS` — **that door is still invite-only** (`auth.ts:54-58`) |
| Per-user usage metering | ❌ not built | `usage_events` collection exists; **nothing writes to it**. Today's usage page reads the operator's own machine (`api/usage/route.ts:11-13`) |
| Keys stored in Appwrite | ❌ not started | separate from the cipher seam |
| Schema as `appwrite.config.json` | ❌ not started | imperative script; DB is `type: legacy` |

**Test totals:** 68 across key-store (13), accounts (13), entitlements (9), release-state (22),
batch-store (11). Sixteen failures elsewhere in the suite are pre-existing BL-026 fallout, confirmed
identical on a stashed tree.

**Before the link goes public:** delete the five test accounts — they are holding 3 of the 10
places — · rotate the Appwrite API key · delete the now-unused `invites` and `seat_claims`
collections.

**One Appwrite setting the app cannot work without:** Auth → Settings → **Email/Password** must be
enabled. A new project has it off, and the failure is nasty — registration succeeds (`users.create`
is an admin call that ignores the setting) and every sign-in then fails with a generic credentials
error. `scripts/appwrite-schema.mjs` now turns it on, so a fresh project cannot be provisioned into
that state.

---

## M · Open decisions — yours, not mine

| # | Decision | Options | Blocks |
|---|---|---|---|
| 1 | Tester with no API key sees…? | locked screen · degraded app | `requireOwnApiKey` being wired |
| 2 | Batch two | raise capacity on `alpha-1` · new batch | nothing; both supported |
| 5 | Waitlist when full | capture the email · just show the message | a `leads` collection (§Q) |
| 3 | End of alpha | keep existing on `alpha` · move everyone to `free` | the POC exit |
| 4 | Does OAuth survive? | keep + BL-045 · delete, email-only | removing the last allow-list |

---

## N · Shortest path to ten people using this

| # | Step | Size |
|---|---|---|
| 1 | Operator dashboard: capacity (10 → 15), accounts, config version, suspend/plan | **the real work, and the only thing left** |
| 2 | Delete the 5 test accounts · rotate API key · drop the dead collections · put the funnel up | minutes |
| 3 | Set capacity to **five** first — break it with people you can phone | — |
| 4 | Then BL-045 (OAuth on capacity), then metering | later |

---
---

# PART TWO — the product model (designed, **none of it built**)

Everything in sections A–N is code that exists. **Everything from here down is a design.**
Nothing in Part Two is implemented. It is larger than everything in Part One combined.

---

## O · The two-layer data model

The tenant boundary was the right answer for *a person's* data. It is the wrong answer for
*a job posting*, because a posting is not anyone's data — it was public on the employer's
site before Jobby saw it.

| | Global layer | Tenant layer |
|---|---|---|
| Holds | canonical job postings | queries, matches, scores, reports, CV |
| Owner | the platform | one account |
| Written by | discovery | evaluation |
| Deduplicated | yes — one row per real posting | no — one row per (tenant × posting) |
| Home | Appwrite | filesystem `tenants/{id}/` |

```
                        GLOBAL — one canonical posting
                                  Job #123
                                     │
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
             Tenant A             Tenant B            Tenant C
          query: backend      query: fullstack     query: platform
             score 91            score 84             score 72
          report (private)    report (private)     report (private)
```

### ⚠️ The correction that changes the build order

> **Sharing the corpus does not save LLM spend. It saves fetching.**
>
> `scan.mjs` is already **zero-token** — it reads Greenhouse/Lever/Ashby APIs, no model
> involved. The tokens are burned in **evaluation**, and evaluation is scored against that
> person's `cv.md`, so it is inherently per-tenant and can never be shared. Ten people
> looking at one posting still costs ten evaluations.
>
> The thing that actually cuts token spend is your **stage 3 — the cheap filter** that
> decides which of 240 discovered postings deserve an LLM call at all. Build that first.
> It is small, it needs no shared corpus, and it works today with the per-tenant files.
>
> The global corpus is still worth building — for dedup across the cohort, for the public
> preview, for repost detection, and for the community layer later. Just do not build it
> expecting the token bill to drop.

---

## P · What is shareable, and what leaks if you get it wrong

| Field | Global? | Why |
|---|:--:|---|
| URL, title, company, location, description, req ID | ✅ | public on the employer's site |
| first_seen / last_seen / liveness | ✅ | a fact about the posting |
| repost count | ✅ | a fact about the employer |
| **which tenant discovered it** | ❌ | reveals who is job-hunting, and where |
| **the search query that surfaced it** | ❌ | the person's intent |
| match score, evaluation, report | ❌ | derived from that person's CV |
| application status, notes, feedback | ❌ | the person's activity |

**Three leak vectors to design against from day one:**

| Vector | The leak | Mitigation |
|---|---|---|
| `discovered_by` on the global row | in a 10-person cohort who know each other, "Ahmad found an NVIDIA job" is a disclosure | never store the tenant id on the global row; keep discovery attribution in the tenant layer only |
| **Public preview of "latest 5 jobs"** | the newest postings are the union of what the cohort just searched for — with ten people in one market that is close to identifiable | draw the preview from a **platform-owned query set**, not from user-triggered discoveries; or sample from ≥30 days of corpus |
| Match counts on a posting ("3 people matched") | reveals cohort behaviour and competition | do not expose counts below a threshold, and never in the alpha |

---

## Q · The waitlist — the one piece of §Q still missing

Open registration is **built** (§D). What is not built is what happens to the person who arrives
one minute too late.

Today a full round returns a 403, shows them the message, and forgets them. That is a lead thrown
away — the people who try to sign up while you are full are exactly the people you want in the next
round.

**A `leads` collection, written when a signup is refused for capacity:**

| Field | Note |
|---|---|
| email, name | what they typed before being refused |
| requested_at | for ordering the next round |
| source | where they came from |
| status | `waiting` · `invited` · `converted` · `declined` |

**Two rules, so this does not quietly become an invitation system again:**

- Joining the waitlist is **optional and separate** — never a required step, never a gate. If
  there is room, registration completes with no waitlist involved at all.
- Being on the waitlist grants **nothing**. When you raise the capacity, those people are simply
  emailed that there is room; they then register through the same open form as everybody else.

---

## R · Killing the token burn — events, not vibes

Your complaint — *"the agent keeps searching and burns tokens with no result"* — is a
**measurement** problem before it is a model problem. The agent must not be the source of
truth for its own progress.

**Pipeline stages, and where money is spent:**

| # | Stage | Cost | Notes |
|---|---|---|---|
| 1 | Discover | API calls only | `scan.mjs`, zero-token |
| 2 | Normalize | free | |
| 3 | Deduplicate | free | today: `normalizeUrlForDedup` into `data/scan-history.tsv` (per-tenant) |
| 4 | **Cheap filter** | free | ⭐ **the one that saves money** — location, title relevance, already-seen, expired |
| 5 | Evaluate | **LLM** | only survivors of stage 4 |

**Progress must be computed from emitted events, never from the model's own claim:**

```
scan.started · source.started · page.completed · job.discovered
job.duplicate · job.filtered · evaluation.started · evaluation.completed · scan.completed
```

A scan record that tells you the truth:

| Metric | Healthy | Broken |
|---|---|---|
| discovered | 240 | 240 |
| new canonical | 34 | **0** |
| matched | 18 | 0 |
| evaluated | 10 | 0 |
| LLM calls | 10 | **35** |

The right column is a bug you can *see*. Today you cannot see either column.

**Quotas — the actual protection.** `usage_events` already exists as a collection and
nothing writes to it (§L); this is what it is for.

| Limit (alpha) | Suggested | Why |
|---|---|---|
| Concurrent scans per account | 1 | a queue is fine; parallel scans are not |
| Searches per day | 5 | |
| Discovered postings per scan | 100 | bounds a runaway sweep |
| LLM evaluations per day | 20 | **the money limit** |
| CV generations per day | 5 | |

Numbers are a starting point, not a finding. The mechanism matters more than the values.

---

## S · Search profiles — the missing entity

Today a tenant has one implicit search (`portals.yml`). The model needs many.

```
Tenant
 └── SearchProfile          "BI Developer"
       ├── queries          ["BI developer", "Power BI", "Data Analyst"]
       ├── locations        [Israel, Remote]
       ├── enabled          true
       └── Matches → Job #123 (score 91) · Job #456 (score 44)
```

The score belongs to the **match**, never to the job: the same posting is a 94 for one
person and a 43 for another. `JobMatch = (job_id, tenant_id, search_profile_id, score,
status, evaluated_at)`.

**Feedback closes the loop** — and is the only way to know whether the scoring is any good:

| Captured | Value |
|---|---|
| 👍 / 👎 on a match | ground truth against the model's score |
| reason: wrong location · seniority · tech · not interested | tells you *which* signal is broken |
| "AI said 87, human said bad, reason = seniority" | the dataset that makes v2 scoring better than v1 |

---

## T · Phasing — what to build, in what order

| Phase | Contains | Size | Depends on |
|---|---|---|---|
| **0 · finish Part One** | rebuild, verify a real signup, operator dashboard | days | nothing |
| **A · let people in** | waitlist/leads, public preview *(open signup itself: done)* | days | phase 0 |
| **B · stop the burn** | scan events, real progress, cheap filter (stage 4), quotas via `usage_events` | 1–2 weeks | phase 0 |
| **C · the product model** | global corpus, canonical dedup, search profiles, JobMatch, feedback | **weeks** | A + B |
| **D · HOLD** | community, referrals, support links | — | proven A–C |

> **Do not start C before ten people are actually using it.** Phase C moves the read path of
> every existing mode — `scan`, `pipeline`, `triage`, `oferta`, the tracker — from markdown
> files to a shared database. That is the largest single change proposed in this document,
> and it is only worth it once you know the product is used. B is where your pain actually
> is, and B is much smaller.

**Canonical dedup key for phase C**, strongest first:

| Rank | Key | Note |
|---|---|---|
| 1 | `(source, external_id)` | exact; what the ATS itself calls it |
| 2 | canonical URL | after normalisation — `normalizeUrlForDedup` exists in `scan.mjs` |
| 3 | `(company, title, location, description_hash)` | fuzzy fallback; reuse `companyRoleDedupKey` from `scan.mjs` |

---

## U · HOLD — community and referrals

Recorded so it is not re-derived later. **Nothing here is in scope until phase D.**

| Idea | Note |
|---|---|
| WhatsApp community for the alpha cohort | use WhatsApp itself — do not build chat |
| Referrer profiles (people inside companies) | needs reputation, or it becomes a spam market |
| Referral discovery attached to a canonical job | the global corpus is what makes this possible |
| "Buy me a coffee / pizza" support links, custom amount | community monetisation, **not** paid referrals |
| Platform fee on support payments | later, and only if the network exists |

**The one hard rule if this is ever built:** never guarantee an outcome for money. A support
link is a thank-you, not a purchase of access.
