# QA round 10 - jobby v0.6.0

- **Verdict:** NOT SHIPPABLE
- **Verified:** 68/75 criteria (90.7%)
- **Commit:** f1e33570
- **Evidence basis:** run report test-results/web-e2e-report.json
- **Blocking:** 3 failing, 3 critical criteria not verified

| state | count |
|---|---|
| pass | 68 |
| fail | 3 |
| skipped | 1 |
| untested | 0 |
| unverified (manual) | 0 |
| blocked | 3 |
| gap | 0 |
| broken link | 0 |
| stale | 0 |

## Since round 9

17 file(s) changed since round 9 at 59a18029.

- **newly passing:** ACCESS-L2-TENANT-01, ACCESS-L2-TENANT-02, ACCESS-L2-TENANT-03
- **regressed:** none
- **passed before, but their code changed since, so re-run:** none
- **carried over (passed before, nothing underneath changed):** none

## Open criteria

| risk | criterion | state | expected | note |
|---|---|---|---|---|
| critical | `ACCESS-L1-01` | fail | suspension makes an existing MCP key return 401 immediately | multi-level-mcp.spec.mjs:297 |
| critical | `ACCESS-L1-02` | fail | a stale session cookie on / lands on the sign-in form, never ERR_TOO_MANY_REDIRECTS | multi-level-mcp.spec.mjs:297 |
| critical | `ACCESS-L1-03` | fail | after reactivation a fresh sign-in works without deleting cookies by hand | multi-level-mcp.spec.mjs:297 |
| high | `ACCESS-L3L4-04` | skipped | a free member cannot resume_generate over MCP | mcp-tools.spec.mjs:64 - skipped in this run |
| high | `CONNECT-UI-06` | blocked | /connect has no serious or critical axe violation | no axe accessibility runner in repo; criterion note says not built yet |
| medium | `PERF-01` | blocked | MCP tools/call p95 latency stays under an agreed SLO | no agreed MCP p95 SLO in manifest |
| medium | `PERF-02` | blocked | /connect Web Vitals stay inside a budget | no agreed /connect Web Vitals budget |

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
| `ACCESS-L0-01` | auto | smoke.spec.mjs:11 |
| `ACCESS-L0-02` | auto | smoke.spec.mjs:21 |
| `ACCESS-L0-05` | auto | smoke.spec.mjs:21 |
| `ACCESS-L0-03` | auto | multi-level-mcp.spec.mjs:146 |
| `ACCESS-L0-04` | auto | mcp-tools.spec.mjs:53 |
| `ACCESS-L1-04` | agent | stale authjs.session-token on GET /signin landed on /signin with Sign in heading visible |
| `ACCESS-L2-KEYLESS-01` | auto | zero-key.spec.mjs:14 |
| `ACCESS-L2-KEYLESS-02` | auto | zero-key.spec.mjs:34 |
| `ACCESS-L2-KEYLESS-03` | auto | zero-key.spec.mjs:43 |
| `ACCESS-L2-KEYLESS-04` | auto | zero-key.spec.mjs:54 |
| `ACCESS-L2-KEYLESS-05` | auto | rbac.spec.mjs:69 |
| `ACCESS-L2-KEYLESS-06` | auto | smoke.spec.mjs:39 |
| `ACCESS-L2-KEYLESS-07` | auto | zero-key.spec.mjs:67 |
| `ACCESS-L2-SCOPE-01` | auto | multi-level-mcp.spec.mjs:153 |
| `ACCESS-L2-SCOPE-02` | auto | multi-level-mcp.spec.mjs:153 |
| `ACCESS-L2-SCOPE-03` | agent | read key resume_update: isError=true, text contains read-only |
| `ACCESS-L2-SCOPE-04` | agent | read key submit_score: isError=true, text contains read-only |
| `ACCESS-L2-SCOPE-05` | auto | multi-level-mcp.spec.mjs:182 |
| `ACCESS-L2-SCOPE-06` | auto | multi-level-mcp.spec.mjs:246 |
| `ACCESS-L2-SCOPE-07` | agent | POST /api/mcp?key=jb_… returned HTTP 401 body: expired — mint a fresh key under Account → MCP |
| `ACCESS-L2-SCOPE-08` | agent | Account→MCP shows status pill expired for e2e-suite; live key count 2/5 with expired excluded |
| `ACCESS-L2-TENANT-01` | agent | search_applications for tenant-B marker returned (0) rows for tenant-A write key; multi-level-mcp.spec.mjs L2 two-member tokens passed |
| `ACCESS-L2-TENANT-02` | agent | whoami tenantId stayed t_<tenant> when tenantId=t_evil query param forced; multi-level-mcp.spec.mjs passed |
| `ACCESS-L2-TENANT-03` | agent | DELETE /api/account/mcp for member-B key from member-A session returned HTTP 404; member-B key still answered whoami 200 |
| `ACCESS-L3L4-01` | auto | multi-level-mcp.spec.mjs:345 |
| `ACCESS-L3L4-02` | auto | multi-level-mcp.spec.mjs:345 |
| `ACCESS-L3L4-03` | auto | multi-level-mcp.spec.mjs:345 |
| `ACCESS-L3L4-05` | agent | alpha-plan read-write key resume_generate returned HTTP 200 without isError |
| `ACCESS-L5-01` | auto | smoke.spec.mjs:54 |
| `ACCESS-L5-02` | auto | rbac.spec.mjs:15 |
| `ACCESS-L5-03` | auto | rbac.spec.mjs:27 |
| `ACCESS-L5-04` | auto | rbac.spec.mjs:59 |
| `ACCESS-L5-05` | auto | multi-level-mcp.spec.mjs:382 |
| `ACCESS-L5-06` | agent | operator /admin row click expanded usage panel: No scan or usage events yet. |
| `MCP-TOOLS-01` | auto | mcp-tools.spec.mjs:98 |
| `MCP-TOOLS-02` | auto | mcp-tools.spec.mjs:106 |
| `MCP-TOOLS-03` | auto | mcp-tools.spec.mjs:151 |
| `MCP-TOOLS-04` | auto | mcp-tools.spec.mjs:184 |
| `MCP-TOOLS-05` | auto | mcp-tools.spec.mjs:190 |
| `FUNNEL-01` | agent | GET https://your-machine.your-tailnet.ts.net:8443/api/mcp returned HTTP 200 content-type text/event-stream |
| `FUNNEL-02` | agent | POST initialize via /api/mcp?key= returned protocolVersion 2025-03-26 |
| `FUNNEL-03` | agent | POST initialize via /mcp/<key> returned serverInfo.name truthy |
| `FUNNEL-04` | agent | tools/list over public URL returned tools.length > 0 |
| `FUNNEL-05` | agent | whoami tools/call over public URL returned HTTP 200 with content text |
| `FUNNEL-06` | agent | MCP host :8443 GET /api/account,/admin,/dashboard,/pipeline all HTTP 404 |
| `JOURNEY-01` | auto | journeys.spec.mjs:50 |
| `JOURNEY-02` | auto | journeys.spec.mjs:82 |
| `JOURNEY-03` | auto | journeys.spec.mjs:120 |
| `CONNECT-UI-01` | auto | zero-key.spec.mjs:21 |
| `CONNECT-UI-02` | agent | Show QR rendered img src data:image/png;base64… length 4206 |
| `CONNECT-UI-03` | agent | POST /api/account/mcp returned jb_ token once; re-list had id but no token field |
| `CONNECT-UI-04` | agent | key row fields scope=read status=live expires=2026-09-08 |
| `CONNECT-UI-05` | agent | maxKeys=5, live count tracked; Add key minted without revoking existing rows |
| `EXTERNAL-CLIENT-01` | manual | ChatGPT Developer Connector https://your-machine.your-tailnet.ts.net:443/mcp/jb_… whoami tenantId=t_<tenant> plan=alpha; add_application chatgpt-r10-qa → tracker row 119 created |
| `EXTERNAL-CLIENT-02` | manual | Cursor path POST http://localhost:3001/api/mcp Authorization Bearer jb_… initialize→2025-03-26 tools/list→23 whoami tenantId=t_<tenant> get_resume 188 chars add_application cursor-r10-qa row 120 created |
| `EXTERNAL-CLIENT-03` | manual | Claude.ai connector https://your-machine.your-tailnet.ts.net:443/mcp/jb_… whoami tenantId=t_<tenant> plan=alpha; add_application claude-r10-qa → tracker row 19 created Evaluated |
| `EXTERNAL-CLIENT-04` | manual | Bearer jb_… whoami HTTP 200 → revoked via DELETE /api/account/mcp → next whoami body {"error":"unauthorized"} |

