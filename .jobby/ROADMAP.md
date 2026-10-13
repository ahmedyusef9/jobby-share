# Roadmap — what "done" means

One milestone at a time. An agent takes ownership of a whole milestone, makes its
own implementation decisions inside it, and reports once. `READY_FOR_REVIEW` is
not permitted while any acceptance box is unticked or any test failure is
unexplained.

**GitHub:** each milestone is a [GitHub Milestone](https://github.com/ahmedyusef9/jobby/milestones);
each implementable unit is issue `[JOBBY-BL-###]`. Sync via the **GitHub MCP server**
(see `.jobby/GITHUB.md` and `.cursor/skills/github-trace/SKILL.md`).

## M1 — Identity and tenant · **COMPLETE**

A stranger registers with no invite and reaches their own isolated dashboard.

- [x] open signup gated only by capacity
- [x] Appwrite credential, Auth.js session
- [x] account → random tenant → provisioned directory
- [x] tenant isolation on every request
- [x] suspend kills a live session
- [x] export and self-service deletion with a grace period

## M2 — Search profiles · not started

A person defines what they are looking for, and can have several.

- [ ] a tenant holds many search profiles: title, queries, locations, enabled
- [ ] profiles supersede `portals.yml` as the query source
- [ ] the CLI toolchain reads them too
- [ ] editing one is idempotent

## M3 — Global discovery · not started

Three people searching the same thing do not create three copies of one job.

- [ ] canonical `job_postings`, global, not tenant-scoped
- [ ] dedup key: `(source, external_id)` → canonical URL → fuzzy `(company, title, location, hash)`
- [ ] discovery attribution never stored on the global row (see SYSTEM.md, leak vectors)
- [ ] re-running a scan adds nothing new

## M4 — Matching and evaluation · not started

The same posting scores differently for different people.

- [ ] `JobMatch = (job_id, tenant_id, search_profile_id, score, status)`
- [ ] score lives on the match, never on the job
- [ ] evaluation reads that tenant's CV only
- [ ] 👍/👎 with a reason, stored per match

## M5 — Execution and progress · **COMPLETE**

You can prove the agent is doing something, and bound what it costs.

- [x] one admission path: quota + concurrency, enforced by a mutex
- [x] both scan and pipeline draw on the same allowance
- [x] operator uncapped, members fail closed when accounting is unavailable
- [x] the scan toolchain runs from a repo-root checkout again (whole suite green)
- [x] scan emits events: source / page / discovered / duplicate / filtered / evaluated / complete
- [x] progress computed from those events, not from the model (`completion` returns null rather than guessing)
- [x] a cheap filter stage before any LLM call — the thing that actually cuts spend
- [x] per-scan counters visible: discovered, filtered, duplicates, evaluated, tokens — `GET /api/scans`

## M6 — Alpha operations · **COMPLETE**

You can run the alpha without touching code.

- [x] operator screen: capacity (10 → 15), signup open/closed, current config version
- [x] accounts list with suspend and plan controls
- [x] scan and usage view per account
- [x] role/plan state served from Appwrite (D-008), `accounts.json` retired
- [x] every operator action works on a second instance without a shared filesystem

## M7 — Trusted execution · **IN PROGRESS** (phases 1 + 3 + 4)

Score/PDF/research cannot lie about being done, and a spawned agent cannot read another tenant.

- [x] job outcomes: `queued → running → validated → succeeded` or `incomplete` / `failed`
- [x] dispatcher verifies report+score+tracker (Score), non-empty `output/` PDF, saved research verdict
- [x] missing artifacts mark the job `incomplete`, not succeeded
- [x] each state change is an Appwrite `job_events` row (no URL, CV, report, or activity text)
- [x] `/admin/runs` metadata-only operator view (phase 2)
- [x] per-job sandbox: tenant folder only, private HOME, no Redis/Appwrite/Docker credentials
- [x] Docker socket stays on the dispatcher; escape test covers sibling tenant + Redis + socket
- [x] per-tenant fair queue (phase 4): at most one running Score and one waiting Score per tenant; UI shows Queued (position #) until the dispatcher starts the sandbox
- [x] nothing publishes on 0.0.0.0: web binds `JOBBY_BIND_ADDR` (loopback default), Redis publishes no port at all, and a test guards both (phase 5)
- [ ] the bind performed on the production host itself — this checkout ran it on your-machine; the production host still needs `JOBBY_BIND_ADDR` set to its tailnet address and `AUTH_URL` moved to match (phase 5)

## M8 — Bring-your-subscription scoring · **superseded by M9**

Grant-scoped Score tools (D-026…D-028) are not the 10-account release. Replaced by D-029…D-033.

## M9 — Friendly 10-account product · **IN PROGRESS** (schema applied; MCP live on localhost)

Ten people can use resume, explore, pipeline, rules/export, and MCP. Host Score is off for members.

- [x] resume: read, write, download `cv.md` from web and MCP (paste/extract on the client's model)
- [x] explore: query + country + distance; ATS + Drushim + LinkedIn/JobSpy
- [x] pipeline: list / save / update / drop jobs with no host evaluate
- [x] rules (`modes/_custom.md`) and account export work
- [x] MCP at `{origin}/api/mcp?key=jb_…` — up to 5 named live keys per account; Add keeps, Rotate all retires
- [x] MCP connect UI: Config + sidebar, token shown once, Cursor/Claude/ChatGPT steps
- [x] plan meters: free / $5 / $10 / $20 (alpha testers = $20 quota, unpaid)
- [x] member `evaluate` returns a deferred message pointing at MCP; operator Score may still run
- [x] `node scripts/appwrite-schema.mjs` on the live project so `mcp_tokens` exists

## R2 — Automated UI e2e (v0.5.1) · **COMPLETE** (2026-08-25) · Milestone [#12](https://github.com/ahmedyusef9/jobby/milestone/12)

Playwright suite at `test/web-e2e/` (16 tests) gating every release: RBAC console,
zero-key member surfaces, MCP tool contracts over raw JSON-RPC, signed-link
delivery. Self-hosted CI gate `jobby-web-e2e` green on Ahmeds-MacBook-Pro.
Found + fixed the #50 dirty-state race on its first run — the pipeline works.

## R1 — MCP-first platform (v0.5.0) · **COMPLETE** (2026-08-23) · GitHub Milestone [#11](https://github.com/ahmedyusef9/jobby/milestone/11) · shipped from `release/v0.5.0`

The product rule became binding: members are zero-key and all scoring intelligence lives in
the user's own assistant (ChatGPT/Claude) through MCP. Jobby stays an isolated multi-tenant
data hub with first-class RBAC management.

- [x] RBAC management console v2: permission matrix, live plan gates, mid-session revocation, audit trail (BL-054)
- [x] MCP resume toolkit: upload / update / signed download link / tailored generate (BL-055)
- [x] MCP job feed: verbatim table (date, time, title, company, posting URL, jobby link) with filters (BL-056)
- [x] MCP score write-back: external AI scores a job; provenance (`scored_by`) stored (BL-057)
- [x] zero-key member loop end-to-end; no member-reachable host LLM call (BL-058)
- [x] BrowserMCP QA pipeline: Cursor agent verifies UI passes and marks features shipped (BL-059)

Verified through five BrowserMCP gate rounds (`deploy/qa/`); fixes landed at
f9b1218, 8c1f4f9, 3960ad2, a534900, a80f013. Known cosmetic debt: inbox/open
copy flashes Config wording until /api/clis resolves.

## R4 — Member MCP-first chrome · **COMPLETE** (2026-09-25)

Make the member UI match D-035. Host keys and Score stay operator-only. Members search from Explore profiles, mark jobs, and score in ChatGPT/Claude/Cursor via `/connect`.

- [x] Members never see or save a host AI API key ([#91](https://github.com/ahmedyusef9/jobby/issues/91) JOBBY-BL-090)
- [x] Explore is where search profiles are defined; those profiles drive every later scan and MCP explore ([#92](https://github.com/ahmedyusef9/jobby/issues/92) JOBBY-BL-091, extends #42)
- [x] Members filter and mark jobs; no platform Score ([#93](https://github.com/ahmedyusef9/jobby/issues/93) JOBBY-BL-092)
- [x] Members copy `/connect` snippets into ChatGPT, Claude, and Cursor ([#94](https://github.com/ahmedyusef9/jobby/issues/94) JOBBY-BL-093)
- [x] Nav lists only destinations the role may use ([#95](https://github.com/ahmedyusef9/jobby/issues/95) JOBBY-BL-094)

All five verified live (Docker rebuild + Playwright as both a real member and
operator account + curl JSON-RPC for the MCP-facing pieces), not from a code
read — see each issue's closing comment for the specific evidence. Two of the
five (#91, #93) were reopened first: their prior closures were fabricated
(BrowserMCP QA claims made against uncommitted code / the wrong page). #92 and
#95 also turned up real gaps beyond their literal issue text (#92: MCP
`explore_jobs` ignored stored profiles entirely when called with no args;
#95: `/jobs` and `/portals` had no server-side operator gate at all, and a
"Retry score" control on `/jobs/[id]` needed its own fix once #95's route gate
turned out not to cover it).

GitHub MCP cannot create milestones. Issues are tagged to **M9**; create
**R4 — Member MCP-first chrome** in the GitHub UI and record `github_number`
in `deploy/github/milestones.json` if you want it broken out as its own
milestone.
