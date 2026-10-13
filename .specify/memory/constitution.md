# Jobby Spec Kit Constitution

## Core Principles

### I. Existing Product Truth Is Authoritative

Spec Kit is a feature-delivery adapter, not a new control plane. `AGENTS.md`,
`DATA_CONTRACT.md`, `.jobby/GITHUB.md`, `.jobby/SYSTEM.md`, `DECISIONS.md`,
`implementation_backlog.csv`, and `.jobby/ROADMAP.md` are authoritative. Feature
artifacts under `specs/` MUST cite those sources and MUST NOT silently replace,
reinterpret, or duplicate accepted product decisions.

### II. User Data Is Never Fabricated or Auto-Updated

The User Layer in `DATA_CONTRACT.md` is sacred. Agents MUST NOT invent CV facts,
comp figures, application outcomes, contacts, or interview stories. Updates MUST
NOT modify user-layer files. System-layer files are the only auto-updatable surface.

### III. GitHub MCP Only — Never `gh` CLI

All GitHub reads and writes use Cursor GitHub MCP (`plugin-github-github`).
Do not install, invoke, or depend on `gh` for issues, milestones, labels, or PRs.
Repo is always `ahmedyusef9/jobby`. Do not run `$speckit-taskstoissues` unless the
human owner explicitly authorizes GitHub issue creation for the reviewed task list.

### IV. Tests and Evidence Before Completion

Implementation follows red-green-refactor. No Spec Kit checkbox, agent assertion, or
generated artifact is test evidence. Completion requires real command output and the
repository's existing verification gates (`qa-pass`, `sdlc-report`).

### V. Bounded, Reversible Delivery

Each Spec Kit feature represents one bounded backlog outcome. Prefer reversible local
defaults. Commits, pushes, merges, and deployments retain human approval.

## Spec Kit Boundaries

- `specs/` contains task-local delivery artifacts. It does not become a second
  backlog or replace `implementation_backlog.csv`.
- `.specify/feature.json` is local machine state.
- Do not install Spec Kit's Git extension.
- Do not use Spec Kit to retroactively specify the entire existing application.

## Development Workflow

1. Check `.jobby/ROADMAP.md` and `implementation_backlog.csv` before claiming work.
2. Run `$speckit-specify` for one bounded outcome and cite its backlog ID.
3. Run `$speckit-plan`, `$speckit-tasks`, and `$speckit-analyze`.
4. Run `$speckit-implement` in bounded slices, then `$speckit-converge`.
5. Update the canonical backlog; generated `tasks.md` is supporting evidence only.
6. GitHub issues, if authorized, go through GitHub MCP only.

## Governance

When this constitution conflicts with `AGENTS.md`, `DATA_CONTRACT.md`, or
`.jobby/GITHUB.md`, those sources win. Amendments require an explicit decision and
must not be erased by upstream template refreshes.

**Version**: 1.0.0 | **Ratified**: 2026-08-30 | **Last Amended**: 2026-08-30
