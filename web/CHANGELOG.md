# Changelog

## Unreleased

* **product:** 10-account release is MCP-first (M9 / D-029–D-033). Resume, explore, pipeline (no host Score), rules, and export run from the web and from `{origin}/api/mcp?key=jb_…`. Member Score is deferred — evaluate on ChatGPT/Claude with that URL. Plans: free / $5 / $10 / $20 scrape+MCP caps; alpha testers get the $20 quota unpaid.
* **mcp:** Config and the sidebar now have a Connect section: mint/rotate/revoke, copy URL + token + Cursor/Claude JSON, and client-specific steps. ChatGPT uses Tailscale Funnel `JOBBY_MCP_PUBLIC_URL` (`/mcp/jb_…` on :8443, No authentication — not OAuth). Claude.ai uses the same origin + Bearer header.
* **explore:** Country and distance (km) pass through to JobSpy/LinkedIn. Scan depth follows the plan's result cap.
* **mcp:** Job search tables add **Posted** column; footer shows plan cap (`showing X of Y`, per-source limit). Search rows have no score — tracker uses **X.X/5**; fit notes in ChatGPT are drafts (not Jobby `/100`). `explore_jobs`/`job_table` gate on `SEARCH_JOBS` + daily MCP quota (v0.4.4).
* **explore:** LinkedIn (JobSpy) and Drushim parsers now pass `postedAt` through to MCP tables (was hardcoded empty in explore-boards).
* **mcp:** Search returns **Briefs** (≤280-char JD summaries) under the lean table; JobSpy fetches LinkedIn descriptions; Drushim passes Description+Requirements; `get_job` returns full Description from recent search cache (v0.4.5).
* **mcp:** Dedicated **/connect** page (nav: MCP) — API key table, plan KPI meters (MCP calls + scans), auto-generated Cursor/ChatGPT/Claude instructions from those KPIs. Config no longer embeds MCP.
* **mcp:** `search_applications` + `update_job`; `add_application` updates notes/score on existing rows; scores accept N/100 → X.X/5; `whoami`/`list_applications` footer show **tenantId** + status counts (v0.4.6).
* **mcp:** Named keys on **/connect** — optional name + ChatGPT/Cursor/Claude suggestions; up to 5 live keys per account; Add keeps existing keys; snippets use the name as the mcpServers id; per-key revoke (v0.4.7).
* **mcp:** Rename live keys (pencil), require a name before Add, Collapse/Done on the secret panel, and a **What's next** checklist after mint (v0.4.8).
* **mcp:** **JOBBY RESPONSE CONTRACT** on initialize, tool footers, `get_rules` → `mcpOutputContract`, and prompts `table` | `score` | `last_24h` — verbatim tables, X.X/5 fit below, stale last-24h handling (v0.4.9).
* **web:** Tracker reader loads `tracker-aliases.json` from the platform root so a Via column no longer shifts Status (Evaluated filters were returning 0).

* **workers:** Score fairness (D-023): at most one running and one waiting Score per tenant on the shared BullMQ queue. The dispatcher also holds a per-tenant run lock so `JOBBY_WORKER_CONCURRENCY>1` cannot start two Scores for the same account. UI shows `Queued (position #)` until the sandbox starts; ETA is serial for this account, not the old 3-wide browser pump. n8n stays optional and must call Jobby's signed API (D-024).
* **workers:** Score/PDF/research is not Done until the dispatcher finds the real files (report + tracker row, PDF in `output/`, saved research verdict). A `VERDICT` line is not completion. Missing files are `incomplete`. State changes go to Appwrite `job_events` (metadata only).
* **workers:** Compose `${JOBBY_HOST_ROOT:-${PWD}}` left HOST_ROOT blank (nested interpolation is not supported). Dispatcher sandbox then failed every Score. HOST_ROOT is now required, and operator OmniRoute is passed into the sandbox.
* **workers:** Queued jobs run in a per-job sandbox when `JOBBY_SANDBOX=1`: one tenant directory, private `HOME`, that tenant's key, no Redis/Appwrite/Docker socket. Compose no longer publishes Redis on the host.
* **workers:** Operator Score uses one OmniRoute model call (`openrouter-runner evaluate`) instead of the OpenCode agent loop that was re-loading the career-ops skill.
* **workers:** OpenCode Score pins `--auto --pure --dir` to the tenant workspace and refuses exit 0 without a `VERDICT` (a permission abort was showing Done with no report).
* **workers:** Operator OpenCode Score on a multi-tenant instance writes OmniRoute config again (D-010 is `mayUseEngine`, not skipping the CLI config). Unconfigured OpenCode was calling `google/gemini-3-pro-image-preview` and exiting 1.
* **explore:** Sources now include Drushim and LinkedIn (existing parsers) alongside Greenhouse / Lever / Ashby / Workday. LinkedIn is JobSpy, not an ATS chip. Resume upload lives on `/cv` when `cv.md` is missing.
* **web:** Auth.js session → `tenantId`; `tenantRoot()` via AsyncLocalStorage throws without context; user data under `/data/tenants/{id}` (JOBBY-BL-020). Signup stays closed until BL-021.
* **cli:** `scripts/resolve-root.mjs` honours `CAREER_OPS_ROOT` + `JOBBY_TENANT_ID` so doctor, merge-tracker, set-status, reserve-report-num, scan, and cv-export read user data under `tenants/{id}` (JOBBY-BL-026). Root `*.mjs` imports are a named local patch — re-apply after `update-system.mjs`.
* **web:** After CV Export PDF, a dialog asks where to save; the OS picker runs on the click, then the dialog flips to Saved + filename + Done
* **cv-export:** Map `## Technical Skills` / `## Professional Summary` onto the HTML payload, and reorder template sections to match cv.md (experience → skills → education)
* **web:** CV chat shows how many lines/sections changed (not only a 20-word SUMMARY) and retries thin positioning edits
* **web:** CV editor Export PDF runs on the Playwright worker (Compose web has no Chromium)
* **web:** First-score aha modal no longer reappears on every refresh (`JSON.parse("1")` broke the seen flag)
* **web:** Jobby wordmark is larger in the sidebar (72px) and mobile header; copyright lockup (`© Jobby · local-first`) sits in the nav footer with Config / Rules; mark also on Today, first-run, Config, Apply, assistant, and the first-score aha
* **web:** Day / dark icon toggle sits next to the wordmark (was at the bottom of the sidebar)
* **web:** CV editor Resume colors — each palette sets headings *and* company names (template teal + purple); custom pickers for both; Preview/Export applies the pair via `scripts/tidy-cv-html.mjs`
* **web:** Optional CV photo on `/cv` — upload, then zoom/drag to place it in the PDF frame (Adjust reopens the original). Stored locally; omitted from the PDF until you add one
* **opencode:** Container Score uses host OmniRoute (`omniroute/auto/best-coding` via Tailscale). Ping `OPENCODE_OMNIROUTE_OK` from worker. (Host `OMNIROUTE_BASE_URL=localhost:22128` must not leak into compose.)
* **workers:** Queue failure visibility — BullMQ failed jobs write run snapshots; `/api/runs/poll` + Workers banner via `/api/queue`; client polls running `runId`s every 5s; PDF button shows fail + retry (JOBBY-BL-010)
* **ci:** `deploy/ci/pdf-smoke.sh` + `web` scripts `ci:compose` / `ci:pdf-smoke` (JOBBY-BL-011/014)
* **deploy:** Playwright worker image `v1.62.0-jammy`; PDF smoke → `output/cv-smoke-bl011-165-2026-08-13.pdf` (JOBBY-BL-011)
* **ci:** Durable compose image build at `deploy/ci/` (+ optional `.github/workflows/jobby-compose-build.yml`) (JOBBY-BL-014)
* **design:** Volume/schema, tenancy, n8n defer decisions under `deploy/design/` (JOBBY-BL-015…017)
* **deploy:** Compose UI documented at `http://localhost:3001` (host 3001 → container 3000); optional `CAREER_OPS_MODEL` note in `deploy/.env.example`
* **deploy:** Local compose Score smoke PASS (OpenRouter → BullMQ worker → `reports/172-arize-2026-08-12.md`); free-model report body thin — pin `CAREER_OPS_MODEL` for quality
* **deploy:** Railway/local multi-container POC — `deploy/docker-compose.yml` (web + BullMQ worker + Redis), OpenCode in-image, OpenRouter API-key engine, local-first `CAREER_OPS_ROOT` mount (see `deploy/.env.example`)
* **web:** Docker production build uses webpack + `spawn(process.execPath)` helpers so Turbopack/`execFile("node")` NFT tracing no longer fails the image build
* **web:** Carbon Emerald branding — tokens (`#2AC282`), DM Sans / Bellefair (+ Heebo / Readex Pro / Noto Naskh), stacked Jobby wordmark + emerald favicon
* **web:** Pipeline inbox row opens a full role page (same Job info / status / Generate CV as Workers) via shared `JobInfoPanel` + `rolePageHref` — no side-pane double-click; unscored uses `/pipeline/open`
* **web:** Manual tracker adds (I applied) keep the posting URL from notes on `/pipeline/[n]` and use Workers-style Job info chrome (no empty “No report” dead-end)
* **web:** Unscored role page shows Scan details (portal, first seen, location) + always-visible Score; Fresh matches cards open that page; Today clarifies Fresh ≠ Pipeline inbox
* **web:** Inbox detail can mark Applied / Discarded / SKIP without scoring — adds a tracker row (score N/A) so status shows under APPLIED/ALL; Shortlist renamed to clarify it is the bottom tray, not Applied
* **web:** Workers job detail shows persistent Job info (company, role, posting URL, copy, report links) for PDF workers — PDF runs only store application `#`, so the LinkedIn/job URL was easy to lose after dismiss

## [0.3.0](https://github.com/santifer/career-ops/compare/web-v0.2.0...web-v0.3.0) (2026-07-07)


### Features

* **patterns:** per-agency advance-rate analysis from the Via channel ([b6ce551](https://github.com/santifer/career-ops/commit/b6ce551e4404f15b20404ecc642886cfe8a2c4c5))
* **tracker:** Via channel — end employer vs recruiter/agency intermediary ([#1599](https://github.com/santifer/career-ops/issues/1599)) ([b66c0b4](https://github.com/santifer/career-ops/commit/b66c0b4a76e9f3738bbddac2ebeb612053e0a9cc))


### Bug Fixes

* **deps:** update npm dependencies ([#1593](https://github.com/santifer/career-ops/issues/1593)) ([253c571](https://github.com/santifer/career-ops/commit/253c5719df403cdaa493db27cdd17349f54f7889))
* **tracker:** retrofit remaining positional readers onto the shared header-aware parser ([#1598](https://github.com/santifer/career-ops/issues/1598)) ([369a5ff](https://github.com/santifer/career-ops/commit/369a5ffcf6623750fcbedbd16be7d3c1c84f1111))
* **web:** 44px tap-targets at the component level ([#1629](https://github.com/santifer/career-ops/issues/1629)) ([388542f](https://github.com/santifer/career-ops/commit/388542f3c0a2f82eeac83be8db5b616c213225b9))
* **web:** contrast tokens — AA across both themes ([#1627](https://github.com/santifer/career-ops/issues/1627)) ([ee89bea](https://github.com/santifer/career-ops/commit/ee89bea997702d40d1cc01620f727bbb66146b9b))
* **web:** portals copy + analytics semantics ([#1628](https://github.com/santifer/career-ops/issues/1628)) ([f8daa19](https://github.com/santifer/career-ops/commit/f8daa19d8ea164dd2bbb63834f2d048a34ccaa63))
* **web:** ux-audit cleanup — CostBadge global CSS + last sub-44 stragglers ([#1648](https://github.com/santifer/career-ops/issues/1648)) ([786b960](https://github.com/santifer/career-ops/commit/786b960c2761e88a534886eafdc9d59f82aba56b))

## [0.2.0](https://github.com/santifer/career-ops/compare/web-v0.1.0...web-v0.2.0) (2026-07-05)


### Features

* experimental local-first web UI (opt-in alpha) ([#1451](https://github.com/santifer/career-ops/issues/1451)) ([1791dc4](https://github.com/santifer/career-ops/commit/1791dc4e3a14aeb10decd852c927bb636aefe00d))
* **pipeline:** optional per-offer note in the pipeline writer ([#1483](https://github.com/santifer/career-ops/issues/1483)) ([6435b1a](https://github.com/santifer/career-ops/commit/6435b1a4dc93a9d441df8768e481d878e3309ae3))
* **web:** Config microcopy humanized (P1.5) ([#1538](https://github.com/santifer/career-ops/issues/1538)) ([8ae3475](https://github.com/santifer/career-ops/commit/8ae347502b8380692a5f80f490bc59f20d1c8491))
* **web:** cost affordance — CostBadge muted (P1.6) ([#1536](https://github.com/santifer/career-ops/issues/1536)) ([b212bb3](https://github.com/santifer/career-ops/commit/b212bb3591de4c374347dec40fc400c4d6ab9bda))
* **web:** dedupe bug reports at write — stable fingerprint + click-gated similar-issue search ([#1473](https://github.com/santifer/career-ops/issues/1473)) ([e13a4f3](https://github.com/santifer/career-ops/commit/e13a4f37d6df9d21c0acca1d1716993df036e01d))
* **web:** empty-state free-scan button (P0.1) ([#1534](https://github.com/santifer/career-ops/issues/1534)) ([28f12e3](https://github.com/santifer/career-ops/commit/28f12e39e3e41104bb7a1f3650a0a508701f82fe))
* **web:** extract cleanChips to a tested module + tab/CR paste delimiter ([#1516](https://github.com/santifer/career-ops/issues/1516)) ([7e676f4](https://github.com/santifer/career-ops/commit/7e676f403e16c84231bb08669c79218615a88c83))
* **web:** inbox triage — Abundance → Triage → Shortlist → Opt-in Score ([#1569](https://github.com/santifer/career-ops/issues/1569)) ([f1e6cc0](https://github.com/santifer/career-ops/commit/f1e6cc0ef2dae1f134e9d6bbb152611107a36308))
* **web:** mobile tap-targets ≥44px + FAB clearance ([#1542](https://github.com/santifer/career-ops/issues/1542)) ([7f6fd1c](https://github.com/santifer/career-ops/commit/7f6fd1c8f34fd0137a995bd2bb4b1f295c8a9303))
* **web:** orange hierarchy — brand-soft Mark-applied + inbox cost legend (P1.4) ([#1537](https://github.com/santifer/career-ops/issues/1537)) ([85d8290](https://github.com/santifer/career-ops/commit/85d829018c7b7225a1bbd547c53b817fd165924d))
* **web:** report progressive disclosure (P0.3+P1.8) ([#1535](https://github.com/santifer/career-ops/issues/1535)) ([30fa1d1](https://github.com/santifer/career-ops/commit/30fa1d19d00bf9a269adcef6778c52a1627d668c))
* **web:** richer bug-report diagnostics — data-shape fingerprint, core version, API errors ([#1469](https://github.com/santifer/career-ops/issues/1469)) ([6a13d8a](https://github.com/santifer/career-ops/commit/6a13d8a7a5448c5f488cac1631a1da471c070335))


### Bug Fixes

* correctness sweep across tracker, providers, and eval reporting ([#1528](https://github.com/santifer/career-ops/issues/1528)) ([bd2a44f](https://github.com/santifer/career-ops/commit/bd2a44f4ee1ea6c6def70200d7750969e67ebadf)), closes [#1527](https://github.com/santifer/career-ops/issues/1527)
* **web:** bump FOLLOW-UPS DUE tap-targets to 44px on mobile ([#1568](https://github.com/santifer/career-ops/issues/1568)) ([f5e8362](https://github.com/santifer/career-ops/commit/f5e836268c8a16707566becb51675d0b52a670dd))
* **web:** pin turbopack.root to prevent Windows postcss OOM ([#1530](https://github.com/santifer/career-ops/issues/1530)) ([8560153](https://github.com/santifer/career-ops/commit/8560153ad8aa37a3993418d32f951f25c868c6c4))
* **web:** point the 'Get one free' link at the free-AI-engine guide ([#1540](https://github.com/santifer/career-ops/issues/1540)) ([8369b40](https://github.com/santifer/career-ops/commit/8369b4001ba63be78818240b9dbc3aa94aebe2e8))
* **web:** restore the report-a-bug kit lost between the RC branch and main ([#1456](https://github.com/santifer/career-ops/issues/1456)) ([b11231f](https://github.com/santifer/career-ops/commit/b11231ffc77dfbd36b745b35df0b6ded3bb73720))
