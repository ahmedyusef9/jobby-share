# QA round 11 - jobby v0.6.0

- **Verdict:** NOT SHIPPABLE
- **Verified:** 70/75 criteria (93.3%)
- **Commit:** round not opened
- **Evidence basis:** run report test-results/web-e2e-report.json
- **Blocking:** 4 critical criteria not verified

| state | count |
|---|---|
| pass | 70 |
| fail | 0 |
| skipped | 1 |
| untested | 0 |
| unverified (manual) | 4 |
| blocked | 0 |
| gap | 0 |
| broken link | 0 |
| stale | 0 |

## Since round 10

14 file(s) changed since round 10 at f1e33570.

- **newly passing:** CONNECT-UI-06, PERF-01, PERF-02
- **regressed:** none
- **passed before, but their code changed since, so re-run:** none
- **carried over (passed before, nothing underneath changed):** EXTERNAL-CLIENT-01, EXTERNAL-CLIENT-02, EXTERNAL-CLIENT-03, EXTERNAL-CLIENT-04

## Open criteria

| risk | criterion | state | expected | note |
|---|---|---|---|---|
| critical | `EXTERNAL-CLIENT-01` | unverified | ChatGPT connects via /mcp/<key> and completes initialize, tools/list, whoami, a read and a permitted write | deploy/qa/round-8-prompt.md §5.3 |
| critical | `EXTERNAL-CLIENT-02` | unverified | Cursor connects and completes the same sequence | deploy/qa/round-8-prompt.md §5.3 |
| critical | `EXTERNAL-CLIENT-03` | unverified | Claude.ai connects over port 443 and completes the same sequence | deploy/qa/round-8-prompt.md §5.3 |
| critical | `EXTERNAL-CLIENT-04` | unverified | revoking the key while a client stays open fails that client's next call | deploy/qa/round-8-prompt.md §5.3 |
| high | `ACCESS-L3L4-04` | skipped | a free member cannot resume_generate over MCP | mcp-tools.spec.mjs:65 - skipped in this run |

## Verified this round

| criterion | via | evidence |
|---|---|---|
| `MCP-PROTO-01` | auto | conformance.spec.mjs:87 |
| `MCP-PROTO-02` | auto | conformance.spec.mjs:101 |
| `MCP-PROTO-03` | auto | conformance.spec.mjs:111 |
| `MCP-PROTO-04` | auto | conformance.spec.mjs:117 |
| `MCP-PROTO-05` | auto | conformance.spec.mjs:129 |
| `MCP-PROTO-06` | auto | conformance.spec.mjs:140 |
| `MCP-PROTO-07` | auto | conformance.spec.mjs:150 |
| `MCP-PROTO-08` | auto | conformance.spec.mjs:157 |
| `MCP-PROTO-09` | auto | conformance.spec.mjs:163 |
| `MCP-PROTO-10` | auto | conformance.spec.mjs:169 |
| `MCP-PROTO-11` | auto | conformance.spec.mjs:175 |
| `ACCESS-L0-01` | auto | smoke.spec.mjs:12 |
| `ACCESS-L0-02` | auto | smoke.spec.mjs:22 |
| `ACCESS-L0-05` | auto | smoke.spec.mjs:22 |
| `ACCESS-L0-03` | auto | multi-level-mcp.spec.mjs:156 |
| `ACCESS-L0-04` | auto | mcp-tools.spec.mjs:54 |
| `ACCESS-L1-01` | auto | multi-level-mcp.spec.mjs:307 |
| `ACCESS-L1-02` | auto | multi-level-mcp.spec.mjs:307 |
| `ACCESS-L1-03` | auto | multi-level-mcp.spec.mjs:307 |
| `ACCESS-L1-04` | auto | multi-level-mcp.spec.mjs:307 |
| `ACCESS-L2-KEYLESS-01` | auto | zero-key.spec.mjs:14 |
| `ACCESS-L2-KEYLESS-02` | auto | zero-key.spec.mjs:34 |
| `ACCESS-L2-KEYLESS-03` | auto | zero-key.spec.mjs:43 |
| `ACCESS-L2-KEYLESS-04` | auto | zero-key.spec.mjs:54 |
| `ACCESS-L2-KEYLESS-05` | auto | rbac.spec.mjs:69 |
| `ACCESS-L2-KEYLESS-06` | auto | smoke.spec.mjs:40 |
| `ACCESS-L2-KEYLESS-07` | auto | zero-key.spec.mjs:67 |
| `ACCESS-L2-SCOPE-01` | auto | multi-level-mcp.spec.mjs:163 |
| `ACCESS-L2-SCOPE-02` | auto | multi-level-mcp.spec.mjs:163 |
| `ACCESS-L2-SCOPE-03` | auto | multi-level-mcp.spec.mjs:163 |
| `ACCESS-L2-SCOPE-04` | auto | multi-level-mcp.spec.mjs:163 |
| `ACCESS-L2-SCOPE-05` | auto | multi-level-mcp.spec.mjs:192 |
| `ACCESS-L2-SCOPE-06` | auto | multi-level-mcp.spec.mjs:256 |
| `ACCESS-L2-SCOPE-07` | auto | multi-level-mcp.spec.mjs:206 |
| `ACCESS-L2-SCOPE-08` | auto | multi-level-mcp.spec.mjs:206 |
| `ACCESS-L2-TENANT-01` | auto | multi-level-mcp.spec.mjs:267 |
| `ACCESS-L2-TENANT-02` | auto | multi-level-mcp.spec.mjs:267 |
| `ACCESS-L2-TENANT-03` | auto | multi-level-mcp.spec.mjs:267 |
| `ACCESS-L3L4-01` | auto | multi-level-mcp.spec.mjs:388 |
| `ACCESS-L3L4-02` | auto | multi-level-mcp.spec.mjs:388 |
| `ACCESS-L3L4-03` | auto | multi-level-mcp.spec.mjs:388 |
| `ACCESS-L3L4-05` | auto | multi-level-mcp.spec.mjs:388 |
| `ACCESS-L5-01` | auto | smoke.spec.mjs:60 |
| `ACCESS-L5-02` | auto | rbac.spec.mjs:15 |
| `ACCESS-L5-03` | auto | rbac.spec.mjs:27 |
| `ACCESS-L5-04` | auto | rbac.spec.mjs:59 |
| `ACCESS-L5-05` | auto | multi-level-mcp.spec.mjs:429 |
| `ACCESS-L5-06` | auto | multi-level-mcp.spec.mjs:429 |
| `MCP-TOOLS-01` | auto | mcp-tools.spec.mjs:102 |
| `MCP-TOOLS-02` | auto | mcp-tools.spec.mjs:110 |
| `MCP-TOOLS-03` | auto | mcp-tools.spec.mjs:155 |
| `MCP-TOOLS-04` | auto | mcp-tools.spec.mjs:188 |
| `MCP-TOOLS-05` | auto | mcp-tools.spec.mjs:194 |
| `FUNNEL-01` | auto | funnel.spec.mjs:85 |
| `FUNNEL-02` | auto | funnel.spec.mjs:93 |
| `FUNNEL-03` | auto | funnel.spec.mjs:101 |
| `FUNNEL-04` | auto | funnel.spec.mjs:108 |
| `FUNNEL-05` | auto | funnel.spec.mjs:114 |
| `FUNNEL-06` | auto | funnel.spec.mjs:126 |
| `JOURNEY-01` | auto | journeys.spec.mjs:50 |
| `JOURNEY-02` | auto | journeys.spec.mjs:82 |
| `JOURNEY-03` | auto | journeys.spec.mjs:120 |
| `CONNECT-UI-01` | auto | zero-key.spec.mjs:21 |
| `CONNECT-UI-02` | auto | connect.spec.mjs:25 |
| `CONNECT-UI-03` | auto | connect.spec.mjs:35 |
| `CONNECT-UI-04` | auto | connect.spec.mjs:35 |
| `CONNECT-UI-05` | auto | connect.spec.mjs:67 |
| `CONNECT-UI-06` | auto | connect.spec.mjs:57 |
| `PERF-01` | auto | performance.spec.mjs:29 |
| `PERF-02` | auto | performance.spec.mjs:81 |

