# QA round 9 - jobby v0.6.0

- **Verdict:** NOT SHIPPABLE
- **Verified:** 32/75 criteria (42.7%)
- **Commit:** 59a18029
- **Evidence basis:** run report test-results/web-e2e-report.json
- **Blocking:** 10 failing, 26 critical criteria not verified

| state | count |
|---|---|
| pass | 32 |
| fail | 10 |
| skipped | 11 |
| untested | 0 |
| unverified (manual) | 4 |
| blocked | 3 |
| gap | 15 |
| broken link | 0 |
| stale | 0 |

## Open criteria

| risk | criterion | state | expected | note |
|---|---|---|---|---|
| critical | `ACCESS-L0-01` | fail | a signed-out member route redirects to sign-in | smoke.spec.mjs:11 |
| critical | `ACCESS-L0-03` | fail | public tools/list succeeds without a key (public by design) | multi-level-mcp.spec.mjs:143 |
| critical | `ACCESS-L1-01` | skipped | suspension makes an existing MCP key return 401 immediately | multi-level-mcp.spec.mjs:234 - skipped in this run |
| critical | `ACCESS-L1-02` | skipped | a stale session cookie on / lands on the sign-in form, never ERR_TOO_MANY_REDIRECTS | multi-level-mcp.spec.mjs:234 - skipped in this run |
| critical | `ACCESS-L1-03` | skipped | after reactivation a fresh sign-in works without deleting cookies by hand | multi-level-mcp.spec.mjs:234 - skipped in this run |
| critical | `ACCESS-L1-04` | gap | /signin itself also settles for a stale cookie (the matrix requires both routes, the test only visits /) |  |
| critical | `ACCESS-L2-SCOPE-01` | skipped | a read key can call whoami and search_applications | multi-level-mcp.spec.mjs:150 - skipped in this run |
| critical | `ACCESS-L2-SCOPE-02` | skipped | a read key's add_application returns a read-only error and persists nothing | multi-level-mcp.spec.mjs:150 - skipped in this run |
| critical | `ACCESS-L2-SCOPE-03` | gap | a read key's resume_update is refused |  |
| critical | `ACCESS-L2-SCOPE-04` | gap | a read key's submit_score is refused |  |
| critical | `ACCESS-L2-SCOPE-05` | skipped | a read-write key mutates only its own tenant | multi-level-mcp.spec.mjs:169 - skipped in this run |
| critical | `ACCESS-L2-SCOPE-06` | skipped | a revoked key returns 401 while another key stays live | multi-level-mcp.spec.mjs:183 - skipped in this run |
| critical | `ACCESS-L2-SCOPE-07` | gap | an expired key returns HTTP 401 with the guidance "expired — mint a fresh key under Account → MCP" | no occurrence of "expired" exists anywhere in test/web-e2e; today this is hand-run per round8 5.1 |
| critical | `ACCESS-L2-SCOPE-08` | gap | an expired key shows a red `expired` pill in Account → MCP and frees the live-key cap | same gap, UI half |
| critical | `ACCESS-L2-TENANT-01` | blocked | neither tenant can list the other tenant's marker row | POST /api/account/mcp returned HTTP 409 minting Member B key (multi-level-mcp.spec.mjs:62). Root cause: scripts/mcp-tokens.mjs:184 enforces MAX_MCP_KEYS=5 live keys per tenant; Member B already holds 5 from earlier runs whose finally-block cleanup did not complete. Fixture exhaustion, not a product defect — but the three isolation guarantees are unverified this round. |
| critical | `ACCESS-L2-TENANT-02` | blocked | a tenantId query parameter cannot override the token's own tenant | POST /api/account/mcp returned HTTP 409 minting Member B key (multi-level-mcp.spec.mjs:62). Root cause: scripts/mcp-tokens.mjs:184 enforces MAX_MCP_KEYS=5 live keys per tenant; Member B already holds 5 from earlier runs whose finally-block cleanup did not complete. Fixture exhaustion, not a product defect — but the three isolation guarantees are unverified this round. |
| critical | `ACCESS-L2-TENANT-03` | blocked | managing another member's key document returns 404 and leaves that key live | POST /api/account/mcp returned HTTP 409 minting Member B key (multi-level-mcp.spec.mjs:62). Root cause: scripts/mcp-tokens.mjs:184 enforces MAX_MCP_KEYS=5 live keys per tenant; Member B already holds 5 from earlier runs whose finally-block cleanup did not complete. Fixture exhaustion, not a product defect — but the three isolation guarantees are unverified this round. |
| critical | `ACCESS-L5-05` | skipped | the operator account listing exposes no raw key and no tenant content | multi-level-mcp.spec.mjs:305 - skipped in this run |
| critical | `ACCESS-L5-06` | gap | aggregate per-account usage is visible to the operator |  |
| critical | `JOURNEY-01` | fail | CV lifecycle — upload → patch → generate → signed download | journeys.spec.mjs:50 |
| critical | `JOURNEY-02` | fail | job hunt and scoring loop — fetch → score → verify → re-score is idempotent | journeys.spec.mjs:82 |
| critical | `JOURNEY-03` | fail | pipeline progression — save → convert to tracker → update status | journeys.spec.mjs:120 |
| critical | `EXTERNAL-CLIENT-01` | unverified | ChatGPT connects via /mcp/<key> and completes initialize, tools/list, whoami, a read and a permitted write | deploy/qa/round-8-prompt.md §5.3 |
| critical | `EXTERNAL-CLIENT-02` | unverified | Cursor connects and completes the same sequence | deploy/qa/round-8-prompt.md §5.3 |
| critical | `EXTERNAL-CLIENT-03` | unverified | Claude.ai connects over port 443 and completes the same sequence | deploy/qa/round-8-prompt.md §5.3 |
| critical | `EXTERNAL-CLIENT-04` | unverified | revoking the key while a client stays open fails that client's next call | deploy/qa/round-8-prompt.md §5.3 |
| high | `ACCESS-L3L4-01` | skipped | the basic plan applies its MCP limit (120) | multi-level-mcp.spec.mjs:274 - skipped in this run |
| high | `ACCESS-L3L4-02` | skipped | the advanced plan applies its MCP limit (500) | multi-level-mcp.spec.mjs:274 - skipped in this run |
| high | `ACCESS-L3L4-03` | skipped | no plan change ever grants admin (/api/admin/accounts stays 403) | multi-level-mcp.spec.mjs:274 - skipped in this run |
| high | `ACCESS-L3L4-04` | fail | a free member cannot resume_generate over MCP | mcp-tools.spec.mjs:64 |
| high | `ACCESS-L3L4-05` | gap | a paid member CAN resume_generate (the positive half of the entitlement) |  |
| high | `MCP-TOOLS-01` | fail | jobs_fetch returns the verbatim table with the full schema and no prose after it | mcp-tools.spec.mjs:98 |
| high | `MCP-TOOLS-02` | fail | resume + score round-trip on a fresh row | mcp-tools.spec.mjs:106 |
| high | `MCP-TOOLS-03` | fail | resume round-trips through a signed download link | mcp-tools.spec.mjs:151 |
| high | `MCP-TOOLS-04` | fail | a score of 9 is rejected before any write | mcp-tools.spec.mjs:184 |
| high | `FUNNEL-06` | gap | the MCP-only host returns 404 for account, admin and dashboard routes |  |
| high | `CONNECT-UI-02` | gap | Show QR renders a PNG data URL | no occurrence of "QR" anywhere in test/web-e2e; hand-run per round8 5.2 |
| high | `CONNECT-UI-03` | gap | a minted token is shown exactly once and never again |  |
| high | `CONNECT-UI-04` | gap | each key row shows its scope, expiry and status |  |
| high | `CONNECT-UI-05` | gap | up to 5 named live keys; Add keeps existing keys, Rotate all retires them |  |
| high | `CONNECT-UI-06` | gap | /connect has no serious or critical axe violation | accessibility testing is not built yet |
| medium | `PERF-01` | gap | MCP tools/call p95 latency stays under an agreed SLO | blocked — no product SLO agreed yet |
| medium | `PERF-02` | gap | /connect Web Vitals stay inside a budget | blocked — no budget agreed yet |

## Verified this round

| criterion | via | evidence |
|---|---|---|
| `MCP-PROTO-01` | auto | conformance.spec.mjs:81 |
| `MCP-PROTO-02` | auto | conformance.spec.mjs:95 |
| `MCP-PROTO-03` | auto | conformance.spec.mjs:105 |
| `MCP-PROTO-04` | auto | conformance.spec.mjs:111 |
| `MCP-PROTO-05` | auto | conformance.spec.mjs:123 |
| `MCP-PROTO-06` | auto | conformance.spec.mjs:134 |
| `MCP-PROTO-07` | auto | conformance.spec.mjs:144 |
| `MCP-PROTO-08` | auto | conformance.spec.mjs:151 |
| `MCP-PROTO-09` | auto | conformance.spec.mjs:157 |
| `MCP-PROTO-10` | auto | conformance.spec.mjs:163 |
| `MCP-PROTO-11` | auto | conformance.spec.mjs:169 |
| `ACCESS-L0-02` | agent | Signed out, GET /admin returned 307 to /signin?callbackUrl=%2Fadmin; delivered HTML had 0 matches for "permission matrix" and 0 for an Operator nav link. Now permanent: smoke.spec.mjs:21. |
| `ACCESS-L0-05` | agent | Signed out, GET /admin/rbac returned 307 to /signin?callbackUrl=%2Fadmin%2Frbac with the same zero leak markers. Now permanent: smoke.spec.mjs:21. |
| `ACCESS-L0-04` | auto | mcp-tools.spec.mjs:53 |
| `ACCESS-L2-KEYLESS-01` | auto | zero-key.spec.mjs:14 |
| `ACCESS-L2-KEYLESS-02` | auto | zero-key.spec.mjs:34 |
| `ACCESS-L2-KEYLESS-03` | auto | zero-key.spec.mjs:43 |
| `ACCESS-L2-KEYLESS-04` | auto | zero-key.spec.mjs:54 |
| `ACCESS-L2-KEYLESS-05` | auto | rbac.spec.mjs:69 |
| `ACCESS-L2-KEYLESS-06` | auto | smoke.spec.mjs:39 |
| `ACCESS-L2-KEYLESS-07` | auto | zero-key.spec.mjs:67 |
| `ACCESS-L5-01` | auto | smoke.spec.mjs:54 |
| `ACCESS-L5-02` | auto | rbac.spec.mjs:15 |
| `ACCESS-L5-03` | auto | rbac.spec.mjs:27 |
| `ACCESS-L5-04` | auto | rbac.spec.mjs:59 |
| `MCP-TOOLS-05` | auto | mcp-tools.spec.mjs:190 |
| `FUNNEL-01` | auto | funnel.spec.mjs:73 |
| `FUNNEL-02` | auto | funnel.spec.mjs:81 |
| `FUNNEL-03` | auto | funnel.spec.mjs:89 |
| `FUNNEL-04` | auto | funnel.spec.mjs:96 |
| `FUNNEL-05` | auto | funnel.spec.mjs:102 |
| `CONNECT-UI-01` | auto | zero-key.spec.mjs:21 |

