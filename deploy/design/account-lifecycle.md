# Account lifecycle: signup, provisioning, sign-out, deletion

Status: BL-038 (index + provisioning) and BL-039 (delete + export) implemented.
BL-034 (Redis session version / 7-day maxAge) is still open — deletion already
bumps `sessionVersion` on the account and `withTenant()` compares it, so a
copied cookie dies without waiting for Redis.
Date: 2026-08-16
Role: ARCHITECT
Extends: `session-strategy.json` (BL-034), `admin-console.md` (BL-035), `rbac.json` (BL-031)
Prompted by: "how the account will be able to signup? ... signup, login, logout, store keys,
delete account ... be thoughtful, not dirty coding solutions"

---

## 0. What exists today, verified

| Stage | State |
|---|---|
| Discover (anonymous) | Nothing — `proxy.ts` redirects every path to `/signin` |
| **Sign up** | First sign-in is signup — no registration form (BL-038) |
| **Provision a new tenant** | `provisionTenant()` seeds marker, tracker header, portals (BL-038) |
| Sign in | Works — operator secret, GitHub, Google (BL-028) |
| Store keys | Works — encrypted, per tenant (BL-021, this branch) |
| Sign out | Partial — clears the cookie and local storage; a copied cookie stays valid |
| **Delete account** | Soft-delete + 7-day grace + contained purge (this document, BL-039) |
| **Export data** | Zip of the tenant directory, keys excluded (this document, BL-039) |

Two consequences worth stating plainly:

**A second person signing in gets an empty room.** `tenantIdFromSubject()` hashes
provider and subject into `t_<16 hex>`, and nothing then creates that directory, writes
the `.jobby-tenant` marker, or seeds `portals.yml` and a tracker. The first write
`mkdir -p`s a bare directory, so the new user lands in an app whose own `doctor.mjs`
reports `onboardingNeeded`. Sign-in succeeding is not the same as an account existing.

**There is no way to leave.** Job-search data says someone is looking to exit their
employer. Offering no deletion is wrong on its own terms, and under GDPR erasure and
portability are obligations, not features — and jobby's users will include EU residents.

## 1. The decision that gets expensive later

Today `tenantId = sha256(provider + ":" + subject)`. The identity *is* the address of the
data. That has two failure modes that cannot be repaired after users exist:

- **One person, two logins, two lives.** Sign in with GitHub on Monday and Google on
  Tuesday and you are two different tenants — two CVs, two trackers, no merge path.
- **Lose the login, lose everything.** Nothing records that an account exists, so there is
  no mapping from a person to their tenant. If their GitHub account goes away, the
  directory is unreachable and unrecoverable, and support cannot help because there is no
  record to look them up by.

Both are the "back to this point again and again" problem: cheap now, migration-shaped
later once real directories carry real data.

**Decision: separate identity from tenancy.** An account owns a tenant; one or more
identities point at the account.

```
identity (provider + subject)  ->  account  ->  tenant (directory)
```

**Decision: build it as a file-backed index now, not Postgres.** A JSON index at the
platform root, written atomically, holding exactly what Postgres would hold later:

```
{platformRoot}/.career-ops-web/accounts.json
{
  "version": 1,
  "identities": { "github:12345": "acct_7f3a", "google:98765": "acct_7f3a" },
  "accounts": {
    "acct_7f3a": {
      "tenantId": "t_9c1e...", "createdAt": "...", "status": "active",
      "emails": ["you@example.com"], "cohort": "alpha-1"
    }
  }
}
```

This removes the trap today at a cost of about a hundred lines, and it is the same shape
BL-035 moves into Postgres — a migration of a small index, not of user directories. The
tenant id stays opaque and stable, so nothing downstream changes when the store does.

Rejected: keeping the hash and "fixing it when we need to". The fix requires moving
tenant directories while users are in them, which is the migration nobody wants to run.

## 2. Signup

**Decision: first sign-in is signup. No separate registration form.**

With OAuth-only there is nothing extra to collect — no password to set, no email to
verify, no reset flow to build. Adding a registration form would add three flows and
buy nothing. What is missing is not a form, it is the **provisioning step** that must run
exactly once when an identity is seen for the first time.

**Provisioning, in order, idempotent:**

1. Check the invite gate. Not invited → refuse before any directory is created.
2. Allocate `accountId`, derive a fresh random `tenantId` (no longer derived from the
   identity, so it survives a login change).
3. Create `tenants/{id}/` with the `.jobby-tenant` marker.
4. Seed the minimum that makes the app usable: `portals.yml` from
   `templates/portals.example.yml`, an empty tracker with its header row, `config/`,
   `data/`, `reports/`, `output/`.
5. Write the identity → account → tenant mapping.
6. Record `signup` in the usage log (BL-035) — the one event that cannot be backfilled.

Provisioning runs in the Auth.js `signIn` callback, where a refusal actually blocks the
session, and it must be safe to run twice: two browser tabs on the first login is normal.

**The alpha gate needs no new code.** `AUTH_ALLOWED_EMAILS` already exists and is already
enforced in the `signIn` callback. Put your five testers' emails in it. Invite codes
(BL-033) are for when a list of emails stops scaling — not for five people.

## 3. Sign-in and sign-out

Sign-in works. Two gaps, both already specified in `session-strategy.json`:

- **Sign-out is local only.** It deletes the browser's cookie. A cookie copied beforehand
  keeps working until it expires, and today that is 30 days. For a session that can spend
  the user's API budget, that is the wrong number and the wrong property.
- **Fix (BL-034):** a session version per account in Redis, stamped into the token and
  compared per request, plus a 7-day rolling session. "Sign out everywhere" then becomes
  a version bump — and the same bump is what account deletion and admin revocation use.

**A suspended or deleted account must fail at sign-in**, not merely lose its cookie.
The `signIn` callback checks account status, so a deleted account cannot sign back in and
silently re-provision itself.

## 4. Deletion — the part that must be done carefully

**Decision: self-service, soft-delete first, then hard purge.**

1. User types their account email to confirm. No single-click destruction.
2. Account status → `deleting`, `deletedAt` stamped, session version bumped so every
   device is signed out immediately, and sign-in is refused from that moment.
3. A **7-day grace period**, stated on the confirmation screen. Job-search data is
   irreplaceable — someone's tailored CVs and application history — and a mis-click at
   midnight should be recoverable. Support restores by clearing the flag.
4. After the grace period, hard purge: the tenant directory, the encrypted key store, the
   identity mappings, and the account row. What survives is anonymised usage counts with
   no tenant id, because deleting billing history is not the same as deleting personal
   data.

**Rules that keep the purge from becoming its own incident:**

- Resolve the directory through `assertInsideTenant()` and refuse anything that is not
  strictly inside `tenants/{id}` — a recursive delete driven by an id is exactly where a
  path bug becomes catastrophic.
- Never accept a tenant id from the request body. It comes from the verified session.
- Revoke the session **before** deleting files, so no in-flight job writes into a
  directory being removed.
- Log the deletion to the audit stream (BL-037) with actor and time, never with content.

**Also delete the keys explicitly.** They live inside the tenant directory, so the purge
covers them — but the code should remove them first and by name, so that the day the key
store moves to Vault or a KMS, deletion still reaches them. Coupling erasure to "the
directory happened to contain it" breaks silently on the first backend change.

## 5. Export

A zip of the tenant directory, minus the encrypted key store, generated on request.

This is cheap precisely because the data model is a directory, and it is worth building
alongside deletion rather than after: it satisfies GDPR portability, it gives a user a way
to leave without losing their work, and "you can take your data and go" is the honest
version of the promise the product already makes about isolation.

## 6. Order of work

1. **BL-038 — account index and provisioning.** Identity → account → tenant, the invite
   gate, and a seeded tenant directory. Nothing else in this document works without it,
   and every day it is deferred is another directory addressed by a hash.
2. **BL-034 — session version and 7-day sessions.** Needed by both sign-out and deletion.
3. **BL-039 — deletion and export.** Soft-delete, grace period, purge, zip.
4. **BL-035 — registry in Postgres.** The index from step 1 moves; the shape does not.

Steps 1 and 3 are what make this an account rather than a directory that appears when
someone logs in.
