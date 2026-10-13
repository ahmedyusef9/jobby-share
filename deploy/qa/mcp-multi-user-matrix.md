# R3 MCP multi-user QA matrix

Run this matrix before closing R3. It validates access control from the user's perspective across anonymous, suspended, member-plan, scoped-key, cross-tenant, and operator levels. Use dedicated QA accounts and unique markers; never use production user content.

## Required identities and key states

- **Visitor:** signed out, no key.
- **Member A:** free plan with live `read`, live `read-write`, expired, and revoked keys.
- **Member B:** a different tenant with a live `read-write` key.
- **Paid member:** Member A temporarily assigned basic or plus.
- **Top-tier member:** Member A temporarily assigned alpha or advanced.
- **Suspended member:** Member A temporarily suspended.
- **Operator:** L5 operator session.

Record `/api/account` before each section: email, tenantId, role, plan, status, operator, and canAdmin. Restore plan/status after testing.

## Manual journey matrix

| Level | Manual journey | Expected result |
|---|---|---|
| L0 visitor | Open `/pipeline`, `/admin`, and `/admin/rbac`; call public `tools/list`; call `tools/call` without a key | App redirects to sign-in; admin stays unavailable; list succeeds; call returns 401 |
| L1 suspended | Suspend Member A while signed in; retry app and MCP calls with an existing key; reload `/` and `/signin` without deleting cookies; reactivate and sign in again | Session/key stop; MCP 401; pages settle on sign-in (no `ERR_TOO_MANY_REDIRECTS`); stale cookie is dropped automatically; restore + fresh sign-in succeed |
| L2 free, no key | Open Config, Account, and Connect | Zero-key copy appears; no host/provider key entry; own MCP key management is available |
| L2 read key | Call `whoami`, `get_resume`, and `search_applications`; attempt `add_application`, `resume_update`, and `submit_score` | Reads succeed; every write returns a read-only error; unique marker never persists |
| L2 read-write key | Add a uniquely named application, read it back, update it, then remove it | All operations succeed only in Member A's tenant |
| L2 expired key | Mint a key, then expire it with `node scripts/qa-expire-key.mjs <name>` and use it | HTTP 401 `expired — mint a fresh key under Account → MCP`; key shows `expired` in Account → MCP and frees the live-key cap |
| L2 revoked key | Revoke one key, retry it, then call with another live key | Revoked key returns 401; unrelated key remains live |
| L2 cross-tenant | Write marker A with key A and marker B with key B; search each marker from the opposite key; append `tenantId` for the other tenant | Neither tenant sees the other's marker; query parameters never override token ownership |
| L2 key ownership | Member A attempts rename/revoke using Member B's key document ID | 404/not found; Member B's key remains live |
| L3 basic/plus | Verify Config, Connect, generate-CV entitlement, MCP quota, and absence of admin | Paid capability and limits apply; zero-key and isolation rules remain unchanged |
| L4 alpha/advanced | Verify CV chat/generate entitlement, 500 MCP/30 scan limits, and absence of admin | Top member capabilities apply; no host AI or admin access |
| L5 operator | Open Admin and RBAC; inspect account rows and usage; publish and restore one RBAC change | Metadata and aggregate usage are visible; no raw key, CV, tracker, report, or prompt content; change is audited |

## Connection and external-vantage journeys

Run against the MCP-only Funnel origin and at least one real external client:

1. Scan the QR or paste `/mcp/<key>` in ChatGPT, Cursor, or Claude.
2. Verify `initialize`, `tools/list`, `whoami`, one read, and one permitted write.
3. Repeat with a read key and confirm the write is refused.
4. Revoke the key while the client remains open; its next call must fail.
5. Mint a 7-day key and confirm scope/expiry metadata is visible in Account → MCP.
6. Confirm the MCP host returns 404 for account/admin/dashboard routes.

See `deploy/docs/mcp-funnel.md` for Funnel setup and release commands.

## Automated release gate

The Playwright suite must run serially against the public full-app Funnel and public MCP-only Funnel:

```bash
JOBBY_E2E_BASE_URL="https://<machine>.<tailnet>.ts.net:8444" \
JOBBY_MCP_PUBLIC_URL="https://<machine>.<tailnet>.ts.net:8443" \
JOBBY_E2E_EMAIL="<member-a>" \
JOBBY_E2E_PASSWORD="<password>" \
JOBBY_OPERATOR_SECRET="<operator-secret>" \
JOBBY_E2E_MCP_KEY="<member-a-read-write-key>" \
npm run test:e2e
```

Mandatory automated coverage:

- `smoke.spec.mjs`: L0, L2, L5 route visibility.
- `rbac.spec.mjs`: L2/L5 matrix visibility and publish/audit/restore.
- `zero-key.spec.mjs`: L2 zero-key and L5 host-engine split.
- `multi-level-mcp.spec.mjs`: L0 unauthenticated behavior, L2 read/read-write/revoked behavior, and L5 metadata-only boundary.
- `conformance.spec.mjs`: protocol and transport contract.
- `funnel.spec.mjs`: external MCP query/path authentication and tool calls.

Two-member isolation requires `JOBBY_E2E_MEMBER_B_EMAIL` and `JOBBY_E2E_MEMBER_B_PASSWORD`; when available, automation must write unique markers through both tenants and prove reciprocal invisibility plus key-management ownership. L1/L3/L4 automation requires an operator-backed fixture that changes Member A's status/plan and restores it in `finally`; until that fixture is added, these levels remain mandatory manual QA.

## Evidence to attach to issues

For each R3 issue, add:

- commit/merge SHA;
- exact automated command and pass/skip/fail totals;
- tested levels and identities;
- screenshots or trace names for UI/client journeys;
- any quota skip with its concrete code and reset time;
- restoration evidence for plan/status/RBAC mutations;
- defect issue links instead of marking acceptance complete when a level fails.
