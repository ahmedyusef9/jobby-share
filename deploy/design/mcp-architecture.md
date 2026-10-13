# MCP Architecture Map — Jobby R3 Platform

This design document provides the single, authoritative architecture map for Jobby's Model Context Protocol (MCP) subsystem, linking every R3 milestone feature to its implementation and verification gates.

```
Client (ChatGPT / Claude / Cursor)
  │ HTTPS via Tailscale Funnel (:8443 / :443)            ← BL-070 runbook
  ▼
/api/mcp or /mcp/<token> (Streamable-HTTP / SSE)         ← BL-067 / BL-068 / BL-075
  │        ── guards: schema · caps · buckets · lockout   ← BL-072
  │        ── auth: Connect key (scope + expiry)          ← BL-075
  ├─ tools/* → tenant-scoped actions (files, tracker, CV) ← BL-063 / BL-069
  ├─ telemetry → usage_events per call                    ← BL-071
  └─ versioning → serverInfo / protocol negotiation       ← BL-076
Admin console /admin/mcp & /admin/rbac                    ← BL-077
Conformance suite (BL-068) + funnel e2e (BL-070)
```

---

## 1. Transport & Connectivity Layer

- **Streamable-HTTP / SSE Negotiation (`BL-067` / `BL-068`):** Implemented in `web/src/app/api/mcp/route.ts` and `web/src/lib/mcp/handler.ts`. Responds to JSON-RPC over `application/json` or SSE (`Accept: text/event-stream`). Wraps JSON-RPC responses into `event: message` SSE frames when requested by ChatGPT or Claude.
- **Authentication Paths (`BL-075`):**
  - Path-based auth: `/mcp/<key>` or `/api/mcp/<key>` (one-link form for ChatGPT/Claude).
  - Query-based auth: `/api/mcp?key=<key>`.
  - Header-based auth: `Authorization: Bearer <key>`.
- **Network Exposure (`BL-070`):** Exposed via Tailscale Funnel. Port `:8443` is the restricted MCP-only host (`JOBBY_MCP_PUBLIC_URL`). Port `:443` proxies standard HTTPS endpoints for clients like Claude.ai that do not accept custom port specifications. Documented in `deploy/docs/mcp-funnel.md`.

---

## 2. Security, Auth, and Key Management (`BL-075`)

- **Token Storage:** Collection `mcp_tokens` in Appwrite (`scripts/mcp-tokens.mjs`). Keys are stored hashed (`sha256`); secrets start with prefix `jb_` followed by 48 hex characters.
- **Key Scopes (`read` vs `read-write`):** Minted with explicit scope. `read` keys permit `whoami`, `jobs_fetch`, `get_resume`, `search_applications`, and `list_inbox`. The central `WRITE_TOOLS` gate in `handler.ts` rejects mutators (`add_application`, `update_job`, `submit_score`, `resume_upload`, etc.) with `isError: true` and explicit read-only guidance.
- **Key Expiration:** Options `never`, `7d`, `30d`. Evaluated at token resolution time. Expired keys return HTTP 401 (`expired — mint a fresh key under Account → MCP`) and do not count toward the 5-live-keys cap.
- **Revocation & Rotation:** Up to 5 live keys per tenant. Rotations retire prior keys atomically.
- **QR Code UX:** Endpoint `/api/account/mcp/qr` returns base64 PNG QR code data URLs for seamless mobile connection.

---

## 3. Guards, Limits, and Abuse Prevention (`BL-072`)

- **Payload Size Cap:** Max body size `256 KB` (`MAX_BODY_BYTES`), rejected at HTTP route with 413 payload too large before JSON parsing.
- **Schema Validation:** Strict JSON Schema input validation (`validateAgainstSchema`). Bad arguments return `-32602` error before consuming quota.
- **Per-Tool Daily Budget:** Budget counters per tenant/tool (`consumeToolBudget`). Exhaustion returns `-32000` with code `TOOL_BUDGET`.
- **Failure Lockout:** Key fingerprint hashes locked after repeated authentication failures (`isAuthLocked`), returning 429.

---

## 4. Multi-Tenant Execution & Data Isolation

- **Tenant Boundary:** Every authenticated MCP call executes inside `runWithTenant({ tenantId, account })` using `AsyncLocalStorage`.
- **Resource Scoping:** Tools access files and collections strictly scoped to `tenantId`. Tenant parameter overrides in request bodies or queries are ignored in favor of the token's authenticated `tenantId`.
- **Zero-Key Policy:** Member accounts carry zero server-side AI keys; AI logic runs on the candidate's own client subscription via MCP.

---

## 5. Versioning & Conformance (`BL-068` / `BL-076`)

- **Protocol Negotiation:** Supports `2024-11-05`, `2025-03-26`, and `2025-06-18`. Negotiated version returned in `initializeResult`.
- **Server Info:** Version string derived from `MCP_SERVER_VERSION` in `scripts/mcp-jsonrpc.mjs`.
- **Conformance Test Suite:** Headless Playwright test suite `test/web-e2e/conformance.spec.mjs` verifying 11 transport & protocol criteria.

---

## 6. Observability & Admin Console (`BL-077` / `BL-078`)

- **Usage Metering:** `mcpUsageToday()` tracks daily MCP call counts against plan limits (`free`: 40, `basic`: 120, `plus`: 250, `advanced`/`alpha`: 500).
- **Admin Isolation:** `/admin` and `/admin/rbac` present tenant metadata and aggregate call counts only; raw key secrets, CV content, reports, and tracker rows are strictly excluded.
- **Audit Trail:** Role, plan, status, and RBAC matrix changes are recorded in the append-only audit ledger (`.career-ops-web/audit.jsonl`).

---

## Verification & Test Artifacts

1. `test/web-e2e/conformance.spec.mjs` — 11-case headless transport conformance suite.
2. `test/web-e2e/funnel.spec.mjs` — 5-case external Funnel transport suite.
3. `test/web-e2e/multi-level-mcp.spec.mjs` — 9-case multi-user RBAC access matrix suite (L0-L5, two-tenant isolation, expired/revoked keys, plan changes, suspension).
4. `deploy/qa/mcp-multi-user-matrix.md` — Authoritative manual & automated QA matrix.
5. `deploy/docs/mcp-funnel.md` — Tailscale Funnel setup & client connection recipes.
