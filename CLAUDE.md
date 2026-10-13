# jobby — agent operating rules

This fork is a multi-tenant product, not a single-user checkout. Before changing
anything, load the contract:

| File | What it settles |
|---|---|
| [.jobby/SYSTEM.md](.jobby/SYSTEM.md) | what jobby is, where state lives, the invariants |
| [.jobby/DECISIONS.md](.jobby/DECISIONS.md) | what is already decided, and the short list that is not |
| [.jobby/ROADMAP.md](.jobby/ROADMAP.md) | the current milestone and its acceptance criteria |
| [.jobby/CURRENT_STATE.md](.jobby/CURRENT_STATE.md) | what is actually true right now, and the named debt |

## Authority

Resolve every question in this order, and stop at the first answer:

1. what the user just told you
2. `.jobby/SYSTEM.md`
3. `.jobby/DECISIONS.md`
4. existing conventions in the code
5. your own judgement
6. ask — only if still genuinely ambiguous

**A discovered inconsistency is not a decision for the user.** If the contract
already resolves it, fix it and say so in the report.

## When you may interrupt

Only these. Everything else you decide yourself:

- **Product behaviour is genuinely open** — and if so it is probably already in the
  `Undecided` table in `DECISIONS.md`.
- **Two accepted decisions conflict.** Name both and stop.
- **The action is irreversible** — deleting data, rotating a live credential,
  publishing to real users.
- **A cost or security boundary moves** — exposing something publicly, spending
  money, widening a trust boundary.

Never ask: where should this live, should this use Appwrite, should I refactor
this, should I move that state, should I add this validation.

## Milestones, not tasks

Work a whole milestone from `ROADMAP.md`. Make the twenty implementation decisions
inside it yourself. Report once, at the end.

**Never report `READY_FOR_REVIEW` while an acceptance criterion is unticked or a
test failure is unexplained.** Classify every failure as: unrelated and
documented, caused by this work and fixed, or unknown — and unknown means not
ready.

Optimise for the milestone and the contract, not for closing the task in front of
you. If the task as asked is the wrong shape — four code paths each
re-implementing the same admission check — say so and build the right one.

## Verification is mandatory before closing an issue

Type-checks, unit tests, and reading the code are not a verdict on a UI page,
REST route, or MCP tool. This project already wrote the bar for that in
`.cursor/rules/45-verify-before-claim.mdc` and `.cursor/rules/80-qa-manual.mdc`
(Cursor-only rules — Claude Code does not auto-load `.cursor/rules/*.mdc`, so
this section carries the same bar here). Before reporting a criterion done,
moving an issue to `READY_FOR_REVIEW`, or closing a GitHub issue:

- **MCP tools** (`list_applications`, `search_applications`, …): call the tool
  through a real connected MCP client (the `claude.ai jobby` connector, or the
  `qa-agent` skill's attended round) and assert the actual response shape.
  Reading `tools.ts` or `tracker-mutate.ts` is not evidence the tool behaves
  that way over the wire.
- **Web UI**: drive it with the `playwright` MCP or `browsermcp` against the
  product origin (`http://localhost:4700` per `qa/project.yml`) and assert
  visible text after exercising the flow — not a first-paint string match, not
  curl'd HTML.
- **REST API routes**: curl/fetch is fine here — assert status code + body
  shape.
- If the live path is unavailable (connector needs re-auth, no QA
  credentials, extension disconnected) — **stop and say so**. Ask the user to
  reconnect it or supply credentials. Do not downgrade to a code read or a
  unit test and report the issue closed anyway; leave it open with an honest
  note of what evidence is still missing.

See the `qa-agent` skill and `qa/project.yml` for the full round mechanics
(evidence ledger, `qa/features.yml` denominator) when the change is big enough
to warrant a full round rather than a single live tool call.

**Closing an issue means updating its `status:*` label too, not just its
open/closed state.** The real label set on this repo is `status:proposed` →
`status:in-progress` → `status:in-qa` → `status:done` (not the `stage:*` names
in `25-sdlc-lifecycle.mdc` — that scheme isn't the one actually applied to
issues here). An issue closed while still wearing `status:proposed` is stale
bookkeeping the same way a milestone marked closed with open issues under it
is — fix it in the same call that closes the issue, swap the old `status:*`
label for `status:done`, don't leave both.

<!-- Career-ops upstream instructions follow. This header is a local patch:
     re-apply it after `node update-system.mjs apply`. -->

@AGENTS.md
