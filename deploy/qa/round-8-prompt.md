# R3 QA — Round 8 prompt (MCP multi-user access + connectivity · v0.6.0)

Target version: **v0.6.0** · Round: **8**

Paste this prompt into the QA automation agent (`@deploy/qa/round-8-prompt.md`):

---

You are running the **Round 8 (v0.6.0) MCP Multi-User Access and Connectivity QA Gate** for jobby.

## 1. Targets

R3 issues: **#64, #66, #71, #74**. Read each issue and its latest comments before testing. Use `deploy/qa/mcp-multi-user-matrix.md` as the authoritative journey/expected-result matrix and `deploy/docs/mcp-funnel.md` for Funnel setup.

## 2. Setup

1. `git pull origin release/v0.6.0`; record HEAD.
2. Rebuild the running stack:
   ```bash
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build web worker
   ```
3. Confirm local app `http://localhost:3001`.
4. Confirm MCP-only Funnel `https://<machine>.<tailnet>.ts.net:8443`.
5. Confirm full-app QA Funnel `https://<machine>.<tailnet>.ts.net:8444`.
6. Prepare identities: visitor; Member A; Member B in a different tenant; operator.
7. Prepare Member A key states: read, read-write, expired, revoked.
8. Record `/api/account` identity/tenant/role/plan/status before each level. Restore all plan/status/RBAC mutations.

## 3. Automated gate

Set both member identities so the cross-tenant test must run:

```bash
JOBBY_E2E_BASE_URL="https://<machine>.<tailnet>.ts.net:8444" \
JOBBY_MCP_PUBLIC_URL="https://<machine>.<tailnet>.ts.net:8443" \
JOBBY_E2E_EMAIL="<member-a>" \
JOBBY_E2E_PASSWORD="<member-a-password>" \
JOBBY_E2E_MEMBER_B_EMAIL="<member-b>" \
JOBBY_E2E_MEMBER_B_PASSWORD="<member-b-password>" \
JOBBY_OPERATOR_SECRET="<operator-secret>" \
JOBBY_E2E_MCP_KEY="<member-a-read-write-key>" \
npm run test:e2e
```

PASS requires **zero failures** and the Member B isolation test must not be skipped. A quota-related skip must be named with its concrete error code and rerun after reset before final shipping.

## 4. Manual multi-level journeys

### L0 — Visitor

1. Signed out, open `/pipeline`, `/admin`, `/admin/rbac`.
2. Call `tools/list` without a key.
3. Call `tools/call: whoami` without a key.

PASS: member routes redirect to sign-in; admin is unavailable; list works; call returns 401.

### L1 — Suspended member

1. Operator suspends Member A while A has an active session and live key.
2. Retry an app route and `whoami` with the old key.
3. Reload `/` and `/signin` in the same browser (stale cookie still present).
4. Reactivate Member A. Reload `/` again, then sign in — do not delete cookies by hand.

PASS: session/key stop working immediately; MCP returns 401; `/` and `/signin` settle on the sign-in form (never `ERR_TOO_MANY_REDIRECTS`); after restore the stale cookie is dropped automatically and a fresh sign-in works. Manual cookie deletion is a FAIL of this level.

### L2 — Free member and scoped keys

1. Verify Config shows zero-key member UX and no host/provider key entry.
2. Mint `read`, `read-write`, and 7-day keys; verify scope/expiry/status metadata and QR.
3. With `read`, call `whoami` and `search_applications`, then attempt `add_application`, `resume_update`, and `submit_score`.
4. With `read-write`, add, read, update, and remove a unique marker.
5. Revoke one key while another remains active.
6. Use an expired key.

PASS: reads work; all read-key mutations return read-only errors and persist nothing; read-write mutations work; revoked key returns 401 without affecting another key; expired key returns explicit expired guidance.

### L2 — Two-member isolation

1. Write marker A using Member A's key and marker B using Member B's key.
2. Search for each marker using the opposite key.
3. Append the opposite `tenantId` as a query parameter and repeat `whoami`.
4. Member A attempts to rename/revoke Member B's key document ID.

PASS: reciprocal invisibility; token-bound tenant cannot be overridden; foreign key management returns 404; Member B key remains live.

### L3 — Basic/plus member

1. Operator assigns Member A basic, then plus.
2. Verify generate-CV entitlement, MCP limits, zero-key UI, no admin, and tenant isolation.
3. Restore the original plan.

PASS: paid limits/capabilities apply; member/admin and tenant boundaries do not change.

### L4 — Alpha/advanced member

1. Operator assigns alpha or advanced.
2. Verify top-tier limits/capabilities, zero-key UI, no admin, and tenant isolation.
3. Restore the original plan.

PASS: top-tier limits apply; no host AI/admin access; isolation remains intact.

### L5 — Operator

1. Open `/admin` and `/admin/rbac`.
2. Confirm account metadata and aggregate usage are visible.
3. Confirm raw MCP keys and tenant CV/tracker/report/prompt content are absent.
4. Publish and restore one RBAC change; verify audit row and L2-L4 behavior within one TTL.

PASS: operator can manage metadata/RBAC only; no secret or tenant-content leakage; restoration/audit are complete.

## 5. Physical & Visual UI Verification Steps (BrowserMCP & CLI)

Execute these explicit visual and physical checks as part of Round 8:

### Step 5.1 — Expired-Key Seam & UI State
1. Mint a key named `expired-test` with 7-day expiry under Account → MCP (`/connect`).
2. Run the QA expiry helper CLI:
   ```bash
   node scripts/qa-expire-key.mjs expired-test --days=1
   ```
3. Refresh `/connect` in BrowserMCP (`browser_snapshot`).
4. **PASS criteria:**
   - Table row for `expired-test` displays a red **expired** status pill and **0 days** under Expires.
   - Calling `/api/mcp?key=<token>` returns HTTP 401 `{ "error": "expired — mint a fresh key under Account → MCP" }`.
   - The expired key does not count toward the 5 live-key cap.

### Step 5.2 — QR Code Rendering & Deep Links
1. Mint a new key `qr-test` under `/connect`.
2. In the secret modal, click **Show QR**.
3. **PASS criteria:**
   - QR code image element (`<img src="data:image/png;base64,...">`) renders cleanly.
   - Deep-link URL displays valid format `https://<machine>.<tailnet>.ts.net:8443/mcp/jb_...`.

### Step 5.3 — First Paint Loading State
1. Open `/connect` on a fresh navigation or simulate network latency.
2. Observe initial paint before `/api/account/mcp` resolves.
3. **PASS criteria:**
   - Initial UI displays `Loading MCP account…` with spinner.
   - Does NOT render `uncapped` or `No live key yet` before fetching completes.

### Step 5.4 — External AI Client Connections (ChatGPT / Cursor / Claude)
1. **ChatGPT Connector:**
   - Settings → Apps & Connectors → Add Developer Connector.
   - URL: `https://<machine>.<tailnet>.ts.net:8443/mcp/<key>` (No authentication).
   - Test: `@jobby whoami` → returns correct `tenantId`.
2. **Cursor:**
   - Merge into `~/.cursor/mcp.json`:
     ```json
     {
       "mcpServers": {
         "jobby": {
           "url": "http://localhost:3001/api/mcp",
           "headers": { "Authorization": "Bearer jb_..." }
         }
       }
     }
     ```
   - Test: `@jobby tools/list` → returns 23 tools as JSON-RPC (not HTML).
3. **Claude.ai / Claude Code:**
   - Claude.ai uses standard `:443`: `https://<machine>.<tailnet>.ts.net/mcp/<key>`.
   - Claude Code uses `Authorization: Bearer jb_...`.
   - Test: `whoami` returns HTTP 200 JSON result.
4. **Revocation check:**
   - Revoke the key under `/connect`.
   - Next call from any client returns HTTP 401 `unauthorized`.

## 6. Evidence and verdicts

For each issue, record:

- Round **8**, target version, release HEAD, identities and levels tested;
- automated command and exact passed/skipped/failed totals;
- BrowserMCP/client evidence and trace/screenshot names;
- expected versus actual for every failure;
- restoration evidence for plan/status/RBAC changes.

Record verdicts only after the full pass:

```bash
node scripts/qa-ship.mjs <issue#> pass --evidence "Round 8: <evidence>"
node scripts/qa-ship.mjs <issue#> fail --note "Round 8: <expected vs actual>"
```

Do not close or merge on failure. Commit QA tracker changes as:

```bash
git commit -am "chore(qa): v0.6.0 round 8 multi-user MCP — <N>/<total> shipped"
```

---
