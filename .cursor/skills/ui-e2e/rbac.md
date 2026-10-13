# Jobby screens × RBAC — BrowserMCP contract

Source of truth for **every HTML URL and query string**, **what each screen is**,
**who may see it**, **which control to click**, and **what must appear / must not**.
Use this when writing RBAC gates, UI copy, or a BrowserMCP pass. Visual filter:
canvas `rbac-screen-catalog`.

Isolation is not a role. Every request binds `tenantId` from the Auth.js session
(`withTenant`). A member with plan `alpha` still cannot see another tenant.

Two roles only (`operator`, `member`) from `scripts/entitlements.mjs`.
Capabilities (`CAP.*`) are named for what a user **does**, not for a route.

Do not copy secrets into this file. Operator secret: `JOBBY_OPERATOR_SECRET` in
`deploy/.env`. Member pack: `.career-ops-web/e2e.local.json`.

Verified against compose `http://localhost:3001` (R1 / BL-058, round 6).

---

## BrowserMCP — how to drive a screen

Namespace: `user-browsermcp`. Schema via `GetDynamicTools` then `CallDynamicTool`.

| Step | Tool | Rule |
|---|---|---|
| Open | `browser_navigate` `{url}` | Always start here. Refs from a previous page are dead. |
| Read | `browser_snapshot` | Pass/fail is **visible text, href, disabled, 404 page** — not “no error”. |
| Click | `browser_click` `{element, ref}` | `ref` from the **latest** snapshot. |
| Type | `browser_type` `{element, ref, text, submit}` | **No `browser_fill`.** `submit: false` unless you mean Enter. |
| Native select | `browser_select_option` | Empty string `""` = Any country. Clicking `<option>` WebSocket-timeouts. |
| Wait | `browser_wait` `{time}` | Use after sign-in, Save, `/api/clis` (zeroKey can take ~1–2s). |
| Proof | `browser_screenshot` | Optional; snapshot text is the contract. |

**Layout trap (mandatory):** the signed-in shell duplicates every nav link —
mobile `dialog "Navigation menu"` **and** desktop `complementary` (`<aside>`).
Always click the **complementary** refs (second Today / Explore / …). The
drawer copy is for the phone overlay.

**Ask / assistant trap:** `Open assistant` is a fixed FAB. On a short viewport
it intercepts clicks on pipeline **Clear** / filters. Snapshot again and retry
the complementary ref if a click times out (30s) or is intercepted.

**If BrowserMCP click dies:** snapshot again and retry on a fresh ref. Do not
switch to Cursor’s built-in browser (different cookie jar). If the extension
is disconnected, stop and ask the user to Connect the correct tab.

**Sign out:** if the complementary **Ahmad** / **Operator** button is missing,
`browser_navigate` `{baseUrl}/api/auth/signout` then click **Sign out**.

**Never click:** Submit / Apply / Send on a real employer site; type the
delete-account confirmation email; Save Rules / CV unless reversing a test.

Pass bar: a loaded URL is not enough. The row below must match.

---

## URL catalog (every HTML screen)

Base in compose: `http://localhost:3001`. BrowserMCP: `browser_navigate` the
full URL. Unauthenticated HTML (except the public rows) redirects to
`/signin?callbackUrl=<path>`.

Primary nav is `NAV_ITEMS` in `web/src/lib/nav-items.ts` — **identical for both
roles**. Admin is **not** in the sidebar.

Member hitting `/admin`, `/admin/rbac`, `/admin/runs`: Next `notFound()` — the
not-found **page**, not a 403 JSON body.

### Auth and session

| Screen | URL | Query | What loads | Member | Operator | BrowserMCP |
|---|---|---|---|---|---|---|
| Sign in | `/signin` | `callbackUrl` (same-origin path only; `/signin` itself is refused → `/`) | Tabs Sign in / Create account; Email; Password; **Operator sign-in** (collapsed when public signup is on) | Form | Form | navigate; type Email/Password `submit:false`; click form **Sign in** |
| Signed-in bounce | `/signin?callbackUrl=/pipeline` | as above | If already signed in, server `redirect(callbackUrl)` | skips form | skips form | do not stay on `/signin` |
| Sign out confirm | `/api/auth/signout` | — | Auth.js “Are you sure… **Sign out**” | yes | yes | navigate then click **Sign out** → `/signin` |

### Sidebar (10 links — click complementary refs)

| Screen | URL | Query | What loads | Member must see | Member must not | Operator extra |
|---|---|---|---|---|---|---|
| Today | `/` | — | Dashboard: decisions, follow-ups, this-week matches; first-run CV drop if no `cv.md`; onboarding “Connect your AI CLI” card may still appear (home copy, not the assistant gate) | Today heading or CV drop | working host Score | same + host Evaluate on match cards |
| Explore | `/explore` | see Explore query table | Scan Free / AI search; Refine search | Scan Free | unlimited scans past plan | uncapped |
| Pipeline | `/pipeline` | see Pipeline query table | Default tab **INBOX** | MCP Score copy after settle | enabled host Score | Score filtered when CLI live |
| Workers | `/jobs` | — | Queue list | **own `tenantId` only** | other tenants’ runs | `opts.all` — every job |
| Portals | `/portals` | — | `portals.yml` editor + **Check portal health** | own file | operator portals | own file |
| Analytics | `/analytics` | — | Own eval roll-up | own numbers | other tenants | own numbers |
| CV | `/cv` | — | Markdown editor, photo **Upload**, preview, PDF export | editor | host CV-chat **Send** working | CLI chat if `cliId` set |
| Rules | `/rules` | — | MUST / SHOULD / HINT | editor | — | editor |
| MCP | `/connect` | — (client chips ChatGPT/Claude/Cursor are **local state**, not URL) | Connect keys: Add / Rotate / copy URL `…/api/mcp?key=jb_…` | primary scoring path | — | same UI + KPI copy |
| Config | `/config` | — | Member: zero-key callout. Operator: CLI + paste key | “Zero-key release” + Account → MCP → `/connect` | Paste an AI key, OpenCode cards | engine chooser + paste key |

### Pipeline URL variants (`web/src/components/pipeline-view.tsx`)

URL is the source of truth for tab/min/sort/dir. Default with no query: **INBOX**.

| URL | Meaning | Details |
|---|---|---|
| `/pipeline` | INBOX | Unscored triage; Score CTA MCP for members |
| `/pipeline?tab=INBOX` | same | Setting tab=INBOX is equivalent to omitting it |
| `/pipeline?tab=FRESH` | This week’s scan hits | Isolated facets (Hebrew titles not hidden by INBOX chips) |
| `/pipeline?tab=ALL` | Full tracker | All canonical states |
| `/pipeline?tab=EVALUATED` | Scored tracker | MCP `submit_score` lands here |
| `/pipeline?tab=APPLIED` | Applied | |
| `/pipeline?tab=RESPONDED` | Responded | |
| `/pipeline?tab=INTERVIEW` | Interview | |
| `/pipeline?tab=OFFER` | Offer | Assistant example: `/pipeline?tab=OFFER&min=4` |
| `/pipeline?tab=REJECTED` | Rejected | |
| `/pipeline?tab=DISCARDED` | Discarded | |
| `/pipeline?tab=SKIP` | SKIP | |
| `/pipeline?min=4` | Score ≥ 4.0 | `min` float; ignored on INBOX/FRESH |
| `/pipeline?q=python` | Search box seed | Local typing after load; URL `q` re-syncs if assistant sets it |
| `/pipeline?sort=date&dir=1` | Sort | `sort` = company\|role\|score\|status\|date; `dir=1` asc, omit or other = desc |
| `/pipeline?job=<postingUrl>` | Legacy deep link | Client `replace` → `/pipeline/{n}` or `/pipeline/open?url=…` (`inbox-triage.tsx`) |

Unknown `tab` falls back to INBOX.

### Role pages (not in sidebar)

| Screen | URL | Query | What loads | Notes |
|---|---|---|---|---|
| Report / job info | `/pipeline/{n}` | `{n}` = tracker row number, unpadded (`/pipeline/42` not `/pipeline/042`) | Status, score, Generate CV, Apply (if PDF ready), report | `rolePageHref({ n })`. Own tenant only. |
| Open posting | `/pipeline/open` | **required** `url` (http/https posting); optional `company`, `role`; `forceScore=1` skips redirect-if-already-tracked | Job info + Score CTA | If already tracked and no `forceScore`, `replace` → `/pipeline/{n}` |
| Example open | `/pipeline/open?url=https://example.com/jobs/x&company=Acme&role=Staff+Engineer` | | | Member CTA “Score via Account → MCP” `/connect` after zeroKey settles |

### Workers detail

| Screen | URL | What loads | Member | Operator |
|---|---|---|---|---|
| Run | `/jobs/{id}` | Status, Activity, Queued (position #), links to pipeline / config | 404 or empty if not own job | any run on the queue |

`{id}` is the BullMQ / run id from the Workers list, not the tracker `#`.

### Account, apply, overlays

| Screen | URL | What loads | Details |
|---|---|---|---|
| Account | `/account` | MCP pointer, export, delete | Complementary Account chip → Account. Operator cannot delete. Delete stays disabled until confirmation email typed — **do not type it in smoke**. |
| Apply proxy | `/apply` | Plain-language form of the live ATS page | No query string. Session is in ApplyProvider (`apply.open(url)` then `router.push("/apply")`). Never click the real Submit on the employer site. |
| Assistant | no URL | FAB **Ask** on every AppShell page | Member: MCP copy, href `/connect`. Operator: `via {cliId}` after save+reload. |
| First-score overlay | no URL | After first evaluate | Buttons → `/pipeline?tab=EVALUATED` or `/explore` |

### Operator-only HTML

| Screen | URL | How to open | Member if URL typed | Operator must show |
|---|---|---|---|---|
| Operator | `/admin` | Account → **Operator** | not-found page | Capacity, sign-ups, accounts, **Access**, **Runs** |
| Access | `/admin/rbac` | `/admin` **Access** | not-found page | plan×cap matrix, Publish, audit |
| Runs | `/admin/runs` | `/admin` **Runs** | not-found page | job outcomes metadata |

### Explore query (`lib/explore.ts` `filtersToParams`)

Shareable search. Omit a key = default.

| Key | Example | Meaning |
|---|---|---|
| `q` | `python,golang` | positive role chips (comma) |
| `not` | `intern` | exclude chips |
| `loc` | `Israel` | Only in |
| `noloc` | `On-site` | Never in |
| `home` | `Remote` | Always include |
| `since` | `7` | posted within days (1–60; default 7) |
| `ats` | `greenhouse,lever,ashby,workday,drushim,linkedin` | sources; omit = all six |
| `limit` | `150` | per-source cap |
| `country` | `Israel` | country |
| `dist` | `25` | JobSpy miles; 0 = any |
| `run` | `1` | auto-fire **Scan Free** on mount (onboarding) |
| `mode` | `ai` | AI hunt (tokens); pair with `intent` |
| `intent` | `staff+backend+israel` | AI search text |

Example: `/explore?q=python&loc=Israel&since=7&run=1`

### Public / no session (not the web app chrome)

These are not AppShell screens. Do not treat them as member/operator HTML.

| URL | Auth | What it is |
|---|---|---|
| `/mcp` and `/api/mcp` | Connect key `?key=jb_…` or `Authorization: Bearer` | MCP JSON-RPC / SSE handshake |
| `/mcp/jb_…` and `/api/mcp/{token}` | token in path | same MCP server |
| `/sse` | MCP origin | SSE probe |
| `/api/resume/{token}` | HMAC in token (~15 min) | PDF/md download; **logged-out private window** |
| `/api/resume/{token}?download=1` | same | `Content-Disposition: attachment` |
| `/icon.svg`, `/brand/…` | none | static |
| Funnel host GET `/` | MCP public host only | `{ name, mcp: "/mcp" }` — **not** the Today dashboard |

Proof APIs used while on a screen (session cookie): `GET /api/account`, `GET /api/clis`, `GET /api/clis?health=1` (slow).

---

## Role identity (prove who you are first)

| Who | How to sign in | Snapshot must show | Must not show |
|---|---|---|---|
| Member | `/signin` → **Sign in** tab → Email + Password → form **Sign in** | complementary button with the **member name** (e.g. Ahmad); tenant `t_…` in Account menu | **Operator** menu item; `/admin` console |
| Operator | `/signin` → **Operator sign-in** → secret → **Continue as operator** | complementary **Operator**; `/admin` loads Capacity + accounts | Member email as the account label |

`GET /api/account` after sign-in:

- Member: `operator: false`, `canAdmin: false`, `role: "member"`, `tenantId: "t_…"`
- Operator: `operator: true`, `canAdmin: true`, `role: "operator"`, tenant `default`

Wrong password: stay on `/signin` with `role=alert`.

---

## Click × show / hide (the RBAC writing table)

Click the complementary control unless noted. **Show** = observable after the
click (or on load). **Hide** = if it appears, the gate is wrong.

### Auth

| Id | Click | Member show | Member hide | Operator show |
|---|---|---|---|---|
| AUTH-01 | Email, Password, **Sign in** | leaves `/signin`; Today | Operator menu | — |
| AUTH-02 | **Create account** tab | form; do not submit in smoke | — | — |
| AUTH-03 | **Operator sign-in** → Continue | — | must not succeed with member password | Admin **Operator**; `/admin` |
| AUTH-04 | Account chip | **Account**, **Sign out**. No **Operator** | **Operator** / **Access** | **Operator**, **Account**, **Sign out** |
| AUTH-05 | **Sign out** | `/signin`; `jobby:{tenantId}:*` cleared | leftover inbox filters for the next user | same |

### Nav (same 10 links both roles)

| Id | Click | Both show | Member hide on that page |
|---|---|---|---|
| NAV-01 | Today | dashboard or first-run CV drop | host Score as a working CTA |
| NAV-02 | Explore | Refine + Scan Free | — |
| NAV-03 | Pipeline | inbox tabs | Score enabled without MCP pointer |
| NAV-04 | Workers | job list | **other tenants'** runs |
| NAV-05 | Portals | own portals | operator portals.yml |
| NAV-06 | Analytics | own stats | other tenants' scores |
| NAV-07 | CV | editor | host CV-chat as a working send (zero-key) |
| NAV-08 | Rules | MUST/SHOULD | — |
| NAV-09 | MCP | Connect keys UI | — |
| NAV-10 | Config | see CFG-* | engine chooser / paste-key **on member** |

### Config / engines (BL-058)

| Id | Control | Member | Operator |
|---|---|---|---|
| CFG-01 | Page copy | “Zero-key release…” + **Account → MCP** → `/connect` | “Run jobby on your own AI…” |
| CFG-02 | **Use an AI tool you have** | **hidden** | visible, recommended |
| CFG-03 | **Paste an AI key** | **hidden** (no OpenRouter card) | visible |
| CFG-04 | Engine list | **No setup needed / Coming soon** only; `GET /api/clis` → `{ clis: [], zeroKey: true }` | OpenCode / Ollama / openrouter-runner / Install links; `{ clis: […], zeroKey: false }` |
| CFG-05 | OpenCode / OmniRoute as a member field | **absent** | host env, not a member Config provider (D-010) |
| CFG-06 | Save | appearance only | persists `cliId` in `jobby:v2:default:config` |

### Scoring refusals (must point at MCP, not Config)

Wait ~1.5s after navigation so `zeroKey` resolves (first paint can still say Config).

| Id | Screen | Click / load | Member show | Member hide |
|---|---|---|---|---|
| SCR-01 | Assistant FAB **Ask** | open panel | setup: “Scoring runs in your own assistant — connect under Account → MCP →” **href=/connect**; header “connect via Account → MCP”; placeholder “Score in your own assistant — see Account → MCP” | “no CLI configured”; “Pick a CLI in Config”; href `/config` |
| SCR-02 | Pipeline inbox | load | link “Score via your own assistant — Account → MCP →” `/connect`; Score filtered **disabled**; tooltip Account → MCP | “Pick Claude or Ollama in Config”; enabled Score |
| SCR-03 | `/pipeline/open` | load a URL | CTA “Score via Account → MCP” `/connect` | “Set up an AI CLI to score” (after settle) |
| SCR-04 | Any host AI route | Score / CV chat / apply autofill | 403 copy: Account → MCP | key prompt; host OpenCode spawn |

Operator assistant **after** OpenCode is selected **and the page reloaded**:
header `via opencode`, placeholder “Ask anything…”, **no** MCP pointer.
Stale “no CLI configured” before reload is React state, not a member leak.

### Operator admin (write these tests first when touching RBAC)

| Id | Click | Operator show | Member (navigate URL directly) |
|---|---|---|---|
| OPS-01 | Account → **Operator** | `/admin` Capacity, sign-ups, accounts table | no menu item |
| OPS-02 | `/admin` **Access** | `/admin/rbac` plan×capability matrix | **404 page** |
| OPS-03 | `/admin` **Runs** | `/admin/runs` job outcomes | **404 page** |
| OPS-04 | Open `/admin` as member | — | not-found page, **not** 403 |
| OPS-05 | Role grant/revoke on a member | succeeds; **that account’s live sessions die** | n/a |
| OPS-06 | Toggle plan cap (e.g. `free` × `search_jobs`) → **Publish changes** | success; audit row `rbac.planCaps.set` with before→after | n/a |
| OPS-07 | Structural rows | text **always** / **never**, **no checkbox** | n/a |

RBAC matrix UI (`web/src/components/rbac-panel.tsx`):

- Editable checkboxes: `search_jobs`, `generate_cv`, `cv_chat`, `score_job`
- Structural (locked): `export_data`, `delete_account`, `admin_console`,
  `admin_manage_accounts`, `admin_rbac`
- **Trap:** `score_job` is editable in the matrix but **no default plan
  includes it**, and even if granted, `mayUseEngine` is operator-only
  (`scripts/entitlements.mjs`). Do not treat a checked `score_job` as “member
  host Score is on”.
- **Trap:** `manage_own_keys` is in the member self-service floor, but R1
  Config **does not** offer paste-key to members. Capability ≠ UI.

### Explore / CV / Workers (unchanged isolation)

| Id | Click | Both | Member extra hide |
|---|---|---|---|
| EXP-01 | **Scan Free** | 0 tokens; quota for members | — |
| EXP-11 | **Add to pipeline** | becomes **In pipeline** disabled | — |
| EXP-12 | **Evaluate** | operator may queue | member: MCP refusal, no BullMQ `evaluate` (D-029) |
| CV-01 | Paste / Upload resume | first-run home and `/cv` when `cv.md` missing | `/cv` toolbar **Upload** is the **photo** |
| WRK-01 | Workers list | member: own `tenantId` only | operator queue-wide |

---

## Capabilities (`CAP`) vs screens

From `scripts/entitlements.mjs`. Operator bypasses plan gating (`can()` returns
true for every cap). Suspended account: only `export_data`.

| Cap | Default plans | Screen it actually changes in R1 |
|---|---|---|
| `search_jobs` | all member plans | Explore / scan quota |
| `generate_cv` | alpha, basic, plus, advanced (not free) | `/cv` generate — still blocked for members by `modelAccessDenied` |
| `cv_chat` | alpha, advanced | `/cv` chat — same zero-key block |
| `score_job` | **none** | inbox Score — host path off for members regardless |
| `export_data` | all (structural always) | Account download |
| `delete_account` | all (structural always) | Account delete; operator cannot delete |
| `manage_own_keys` | all | Config paste — **hidden for members in R1** |
| `admin_console` | never on a plan | `/admin`, `/admin/runs` |
| `admin_manage_accounts` | never | `/admin` accounts PATCH |
| `admin_rbac` | never | `/admin/rbac` |

When you **write new RBAC**, add a row here **and** a BrowserMCP id (OPS-/NAV-/CFG-/SCR-)
with show/hide. Do not gate with an inline `role ===` at a new call site — go through `can()`.

---

## Recommended BrowserMCP order for an RBAC change

1. Member session: complementary nav all 10 links; `/admin` → 404; no Operator menu.
2. Member Config + Ask + inbox Score copy (SCR-01..03) still MCP.
3. Sign out (`/api/auth/signout`).
4. Operator: `/admin` → Access → toggle one editable cap → Publish → audit row.
5. Operator: change a member Role to operator and back (sessions die).
6. Member again: confirm the published cap (or 404) matches the matrix.

Record verdicts with `node scripts/qa-ship.mjs` when the change is a shipped issue.
