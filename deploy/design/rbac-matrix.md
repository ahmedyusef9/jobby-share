# RBAC Matrix — roles, plans, features, and the loading mechanism

Source of truth for who may do what. Implementation: `scripts/entitlements.mjs`
(gate) · `scripts/config-store.mjs` + `scripts/release-state.mjs` (persistence)
· `web/src/app/api/admin/rbac/route.ts` (console API) · `scripts/rbac-audit.mjs`
(trail). Where code and this doc disagree, the code wins — file an issue.

## 1. The three axes

| Axis | Values | Answers |
|------|--------|---------|
| **Role** | `operator` · `member` | WHAT KIND of user |
| **Plan** | `alpha` · `free` · `basic` · `plus` · `advanced` | HOW MUCH a member may do |
| **Capability** | `CAP.*` (below) | WHICH action |

Rules that make the axes orthogonal:
- Operator is **not** the top plan — it bypasses plan gating entirely (`can()` line 1: role check before any plan lookup).
- Suspended/deleting accounts answer `false` for everything except `export_data`, regardless of role.
- Structural capabilities can never be granted to a plan by an override (`applyPlanCapOverrides` rejects them).

## 2. Capability catalog

| Capability | What it gates | Class |
|-----------|---------------|-------|
| `search_jobs` | explore/pipeline discovery | self-service floor |
| `export_data` | account data export | structural (always available, even suspended) |
| `delete_account` | self-service deletion | structural |
| `manage_own_keys` | tenant key store CRUD | self-service floor (dormant under zero-key) |
| `score_job` | host-side AI scoring | **deferred** — members get MCP pointer (D-029/BL-058) |
| `generate_cv` | CV render/chat generation | metered feature |
| `cv_chat` | CV chat assistant | metered feature |
| `admin_console` | /admin visibility | structural operator-only |
| `admin_manage_accounts` | accounts mutations | structural operator-only |
| `admin_rbac` | /admin/rbac matrix editor | structural operator-only |

## 3. The default matrix (release defaults)

Member-reachable capabilities per plan:

| Capability | alpha | free | basic | plus | advanced | operator |
|------------|:-----:|:----:|:-----:|:----:|:--------:|:--------:|
| search_jobs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| export_data | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| delete_account | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| manage_own_keys | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| generate_cv | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| cv_chat | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| score_job (host) | ❌* | ❌* | ❌* | ❌* | ❌* | ✅ |
| admin_console | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| admin_manage_accounts | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| admin_rbac | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

\* `score_job` denial is product policy (zero-key), not a plan limit — members get the
MCP pointer regardless of plan; the operator bypasses because it is a different kind of user.

Daily quotas (`PLAN_LIMITS`, independent of capabilities):

| Plan | priceUsd | scans/day | mcp calls/day | results/run |
|------|----------|-----------|---------------|-------------|
| free | $0 | 3 | 40 | 40 |
| basic | $5 | 8 | 120 | 80 |
| plus | $10 | 15 | 250 | 150 |
| advanced | $20 | 30 | 500 | 250 |
| alpha | $0 | 30 | 500 | 250 |

Operator: uncapped (null limits).

## 4. Loading mechanism (how the matrix reaches a request)

```
release defaults (PLAN_CAPS, code)
        ↓  publish
app_config.rbacPlanCapsJson      ← live config version in Appwrite (scalar JSON string;
        ↓  getConfig() TTL          "" = pure defaults; validated the moment it parses)
web process cache
        ↓  applyPlanCapOverrides()  ← throws on bad shape → falls back to defaults,
can(request)                          never half-applies; rollback if publish fails
```

Properties (each is a tested invariant):

1. **No restart.** Publishing a config version propagates to every instance within one TTL; `/api/admin/rbac` GET re-syncs from the store, healing processes that started before the publish.
2. **Fail closed to defaults.** Corrupt stored JSON logs loudly and uses release defaults — a broken override cannot widen access.
3. **Validation at the edge.** Unknown plan keys, unknown capability ids, non-array values, and any attempt to grant structural/admin caps to a plan throw precise errors → 400, nothing persisted.
4. **Atomic publish-or-rollback.** If `patchActiveConfig` fails validation downstream, the in-process copy is restored from `before`.
5. **Audit every mutation.** Role/plan/status/matrix changes append before→after rows to `.career-ops-web/audit.jsonl`; the console tails them.
6. **Revocation kills sessions.** `setAccountRole` bumps `sessionVersion` → all tokens die mid-flight. Plan/status changes intentionally do NOT bump — authority is read per request, so they apply on next request without kicking anyone.
7. **Worker boundary (known gap, tracked):** `can()` runs in the web process; the worker gates via account status + engine rules. Overrides affecting web-only caps do not need worker reload today; if a worker-gated capability ever becomes overridable, the worker must subscribe to config versions too.

## 5. Levels — the test ladder

Every RBAC change is verified against these six levels, in order:

| Level | Who | Must hold |
|-------|-----|-----------|
| **L0** visitor | no session | member surfaces redirect to /signin; admin routes unreachable; MCP returns auth error |
| **L1** suspended | status ≠ active | only export_data works; sessions already dead; sign-in refused |
| **L2** free member | plan=free | self-service floor only; NO generate_cv/cv_chat (denial → MCP pointer); zero-key Config |
| **L3** paid member | basic/plus | + generate_cv; still no cv_chat (except advanced) |
| **L4** alpha/advanced member | top member tier | + cv_chat; quotas at 500/30; still zero host-AI, still no admin |
| **L5** operator | role=operator | everything above + admin console + RBAC editor + host engines; suspending the operator still suspends the operator |

An override edit (L5 acting) must be re-verified at L2–L4 within one TTL, then audited.

## 6. Enforcement points map

| Surface | Gate | Reads |
|---------|------|-------|
| Admin pages/APIs | `denyUnlessOperator(CAP.*)` server-side | role via session |
| Member model routes | `modelAccessDenied()` → zero-key refusal | role first, then key, then plan |
| Engine spawns (inline + worker) | `assertSelfFundedEngine()` | role + status |
| MCP tools | handler quota (`consumeMcpCall`) + per-tool tenant scoping | plan limits |
| UI cards/copy | `/api/clis` `zeroKey` flag + `can()` on server render | same gate, one source |
| Signup | capacity slot + live config (`signupOpen`, batch state) | config store |
