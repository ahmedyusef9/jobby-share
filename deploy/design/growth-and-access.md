# Signup funnel, access tiers, RBAC and the alpha batch

Status: proposed
Date: 2026-08-15
Role: ARCHITECT
Extends: `tenancy.json` (BL-016), `entitlements.json` (BL-023), `secrets-custody.json` (BL-021)

---

## 0. The one decision that changes the recorded plan

`entitlements.json` assumed the platform pays for scoring on Trial and Basic (a house key),
with bring-your-own-key reserved for the Advanced tier. Your rule for alpha inverts that:
**nobody's tokens get paid for, and a user's own key is the only way to score.**

That inversion has a consequence worth naming before anything else: **JOBBY-BL-021,
per-tenant encrypted key custody, moves from "nice tier feature" to launch-blocking.** If
BYO is the only scoring path, then every scoring user hands us a credential on day one.
Today those keys land in a plaintext `secrets.env` and get spread into every spawned CLI
through `process.env` — acceptable for one local operator, not for twenty invited testers.

The good news is that the alpha is *cheaper and safer* than the recorded plan: with no
house key, there is no platform spend to meter, no billing to build, and no quota engine
needed to launch. Metering becomes a measurement exercise instead of a control system.

---

## 1. The funnel: what an anonymous visitor can do

Today nothing is public. `web/src/proxy.ts` redirects every unauthenticated path to
`/signin`, so a first-time visitor sees a password box and leaves. There is no surface to
be curious about, which is the actual reason signups would not happen.

Three tiers, and only the first is new:

| Tier | Identity | Can do |
|---|---|---|
| **Visitor** | signed anonymous cookie, no account | Run a job search by role and region; see a teased result set; save nothing |
| **Searcher** | account, own tenant | Everything in the product except LLM work — full search, inbox, tracker, CV editor, PDF export, follow-ups |
| **Scorer** | account + their own API key | Adds evaluation, CV chat, assistant, match hints |

The visitor tier needs a public route group that the proxy allows through — `/`, `/search`,
`/api/public/search` — with everything else still closed. That allowlist is the whole
security surface of the funnel, so it should be an explicit list, never a pattern.

## 2. The teaser, done honestly

Your instinct is right: show that 15 roles matched, reveal 5, hold 10 back. One
implementation detail decides whether it works or embarrasses us.

**The held-back rows must never be in the response.** If the server sends 15 results and
CSS blurs 10, the data is in the page source and anyone who opens devtools reads it —
worse, it looks like a company that thinks a blur is a security control. The server sends
5 complete rows plus 10 *masked* rows carrying only what is safe to show: posting age,
location, and a company initial. The count is real, the withheld detail is genuinely
withheld.

**The blur is the hook, the saved search is the reason to come back.** Curiosity gets a
signup; a standing query gets a returning user. After the teased result, the strongest ask
is not "see 10 more" but "we will keep watching *Backend Engineer · Israel* and show you
what is new". That costs nothing — it runs on the shared catalog crawl (BL-024), zero
tokens — and it is the same supply loop `/api/whats-new` already implements for signed-in
users.

**Carry the search across signup.** The anonymous cookie exists so that the search a
visitor ran becomes the first saved search in their new tenant. A funnel that makes people
retype what they just typed leaks most of the people it convinced.

**One legal caution, not a blocker.** Indexable public search pages are a bigger
acquisition channel than the blur will ever be, but republishing scraped ATS content is
not the same as scanning it for personal use. Publish the facts and the link — company,
title, location, date, URL — and never the job-description body.

## 3. What is free, and when

**Alpha (now): everything free except LLM work.** Not "free trial" — free, with no card
and no expiry, because the marginal cost of a free user is a few megabytes of markdown and
some Playwright CPU. The only metered thing is tokens, and in alpha the user brings those.

One distinction that will otherwise get muddled: **editing the CV is free, talking to the
CV is not.** `/api/cv` (open, edit, save, version, export PDF) is deterministic and runs
with no model in the loop — `scripts/cv-export.mjs` exists precisely so a resume PDF costs
nothing. `/api/cv/chat` is a model call and sits behind the same gate as scoring.

| Capability | Visitor | Searcher (free) | Scorer (own key) |
|---|---|---|---|
| Search, teased | ✅ | — | — |
| Search, full + saved searches | — | ✅ | ✅ |
| Inbox, pipeline, tracker, follow-ups | — | ✅ | ✅ |
| CV editor, versions, PDF export | — | ✅ | ✅ |
| Score a role (A–F evaluation) | — | ❌ | ✅ |
| CV chat, assistant, match hints, form fill | — | ❌ | ✅ |
| Scheduled scans, batch fan-out | — | ❌ | later, paid |

## 4. RBAC: the honest answer is that you do not need it

Role-based access control solves *many users sharing resources with different rights*.
Jobby has one user per tenant and no shared resources — the boundary that matters is
`tenantRoot()`, already built in BL-020. Adding a role/permission matrix on top would be
ceremony over a boundary that is already absolute.

What is actually needed is three separate things that RBAC tends to blur together:

1. **Isolation** — which tenant's files am I allowed to touch? Answered by the session's
   `tenantId`. Done.
2. **Entitlement** — is this capability unlocked for this account? Answered by plan plus
   whether a key is attached. This is commercial, not security.
3. **Role** — a genuinely small dimension: `user` (owns exactly one tenant) and `admin`
   (platform staff). That is the entire role model for alpha.

Implement it as one claim on the session and one function:

```ts
can(ctx, "score.run")     // entitlement + role in one call site
```

Keep the signature able to consult role, plan and (later) membership, so growing into
teams does not mean rewriting call sites. Do not build a permissions table, a role editor,
or role hierarchies — none of them have a user.

**The trap to avoid:** an `admin` role that can read any tenant quietly undoes BL-020.
Admin gets platform-level things — usage counters, feature flags, queue health, error
rates — and *never* tenant file reads. If support genuinely needs to look inside an
account, that is an explicit, time-boxed, audited impersonation grant that the tenant can
see, not a permission bit.

**Revisit when:** a recruiter or agency manages several searchers. That is many-to-many
user↔tenant membership, which is relationship-shaped, not role-shaped, and it changes the
tenancy model rather than adding a role.

## 5. Pricing, once there is something to charge for

There is nothing to charge for in alpha, so the useful work now is measuring what a paid
tier would cost you. **The app already captures per-run cost** (`/api/run` records it, and
`explore-cost.ts` models the free path), so after a few weeks of alpha you can price from
observed numbers instead of guessing.

The method, so the number is defensible: `price = quota × measured cost per evaluation ×
safety factor`, then round to something that does not feel like an accounting exercise.

A shape to aim at, deliberately small as you asked:

| Plan | Price | What it buys |
|---|---|---|
| **Free** | €0 | Everything except model work. BYO key unlocks scoring at your own cost. |
| **Plus** | ~€8/mo | Scoring on our key with a monthly quota, saved searches watched daily, priority queue |
| **Pro** | ~€19/mo | Larger quota, batch fan-out, multiple tailored CV variants, interview prep |

The free tier stays genuinely useful forever — the paid tiers sell *not having to manage a
key and a token budget*, which is a real convenience, rather than withholding the pipeline.

## 6. Batches and how feedback actually reaches you

A lot of this already exists and is better than most alphas ship with: `/api/version`
returns a version and channel, and `beta-banner.tsx` opens a **pre-filled GitHub issue**
with a PII-scrubbed diagnostic payload, a preview-then-confirm step, and a duplicate
search. Four gaps stand between that and a batch programme.

1. **Bug reports currently open issues on `santifer/career-ops`** — the upstream project.
   Invite twenty testers today and their reports land in a stranger's tracker. Retarget the
   repo before the first invite. This is the single cheapest blocker to clear.
2. **Nothing captures non-bug feedback.** Add one in-product prompt for "what were you
   trying to do?" — feature requests and confusion never arrive as bug reports.
3. **No cohort identity.** Record which batch an account joined in and five events per
   user: signed up, ran first search, attached a key, scored once, came back on day 7.
   Five events answer "is this working"; an analytics platform does not.
4. **No release channel to users.** `/api/whats-new` is the *job* supply loop, not release
   notes, so there is currently no way to tell a tester what changed since their last
   visit. A per-version changelog surface closes the loop that makes people re-engage.

**Batch shape:** alpha behind invite codes (~20 users, BYO key only, feedback weekly) →
beta with open signup (still BYO, funnel and catalog under load) → GA when the measured
cost per evaluation supports the Plus price. Invite codes are the cheapest possible cohort
control and they double as attribution.

## 7. Order of work

1. **BL-021 — encrypted key custody.** Now launch-blocking: BYO is the only scoring path.
2. **BL-029 — public tier**: proxy allowlist, anonymous cookie, `/api/public/search`.
3. **BL-030 — teaser with server-side masking** and the saved-search capture at signup.
4. **BL-031 — `can()` plus the two-role claim**, replacing scattered checks.
5. **BL-032 — alpha feedback loop**: retarget the issue repo, cohort events, changelog.
6. **BL-033 — invite codes** to bound the batch.

Pricing, quotas and billing are deliberately absent from this list. None of them can be
sized honestly until alpha produces cost numbers.
