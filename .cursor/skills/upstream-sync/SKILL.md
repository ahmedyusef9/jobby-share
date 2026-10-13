---
name: upstream-sync
description: Safely pull upstream career-ops changes into jobby, and contribute fixes back. Use when updating, syncing with upstream, resolving a fork conflict, or when a system-layer file needs to change.
---

# Upstream sync

`jobby` = `ahmedyusef9/jobby` (origin), forked from `santifer/career-ops` (upstream).

Two independent update mechanisms exist. Know which one you want.

| Mechanism | Scope | Use when |
|-----------|-------|----------|
| `node update-system.mjs apply` | Checks out upstream `main` over `SYSTEM_PATHS` only. Leaves user-layer files alone. | Normal case — you want the latest product behavior. |
| `git merge upstream/main` | Whole tree, real git history. | You need full history, or you are preparing a PR upstream. |

## Routine update

Always confirm with the user before applying — upstream's `AGENTS.md` requires it.

```bash
git status --porcelain          # must be clean; commit or stash first
node update-system.mjs check
node update-system.mjs apply
node test-all.mjs
```

If it goes wrong: `node update-system.mjs rollback`.

The updater overwrites system paths without producing a git conflict, so uncommitted work
in those paths is lost silently. Committing first is what makes it recoverable.

## Keeping git history aligned

```bash
git fetch upstream
git merge --ff-only upstream/main
git push origin main
```

Keep `main` a clean mirror. If `--ff-only` fails, something local landed on `main` that
should have been a branch — move it off before continuing.

## Verify the overlay survived

After any update:

```bash
git status --porcelain .cursor/rules/
# `.cursor/skills/career-ops/` is system (upstream from v1.26). Other
# `.cursor/skills/*` are jobby extras; the updater keeps them unless `--force`.
```

`.cursor/rules/**` is ours and versioned. `modes/_custom.md`, `modes/_profile.md`, and
`config/*` are ours and gitignored. Upstream v1.26 added `.cursor/skills/` to
`SYSTEM_PATHS` and ships `.cursor/skills/career-ops/SKILL.md`. Do not author jobby
content under `career-ops/`. If `.cursor/rules/` ever lands in `SYSTEM_PATHS`, stop
and re-plan where the overlay lives.

## Contributing a fix upstream

A bug in upstream code is not a customization, and patching it locally means losing the
patch on every update. Send it upstream instead.

```bash
git checkout -b fix/<kebab-slug> upstream/main
# minimal diff + regression test
node test-all.mjs
gh pr create --repo santifer/career-ops
```

Branch from `upstream/main`, not from local `main`, so the PR carries no fork noise.
Conventional commit subject — upstream runs `release-please`. Read `CONTRIBUTING.md` and
`GOVERNANCE.md` first; the project is MIT with a `CODE_OF_CONDUCT.md` and a `SIGNATURES.md`
process.

## If a local system-file patch is truly unavoidable

Record it as a named branch plus a one-line note in `modes/_custom.md` under Off-Limits, so
the next update knows to re-apply it. Treat this as debt, not a solution.
