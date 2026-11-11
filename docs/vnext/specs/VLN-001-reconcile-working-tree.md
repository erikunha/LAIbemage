# VLN-001 — Reconcile public vNext design with unpushed agent work without losing any changes.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Reconcile public vNext design with unpushed agent work without losing any changes.

## In scope / out of scope
Read-only inventory of branches, dirty files, untracked spec-kit, contracts, migrations, tests and CI; classify KEEP / AMEND / DEFER / CONFLICT per subsystem.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Do not automatically switch branches. Capture `git status --porcelain=v1`, branch SHA, diffs and package exports. Reuse existing `feat/visual-lens` work and accepted ADRs. Write `docs/migration/vnext-reconciliation.md` in a new branch; unresolved collisions remain explicit.

## Contract and data effects
No public runtime contract change. Output one Markdown report with branch/source provenance and SHA for touched files.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
Report lists every impacted package and conflicting ADR, includes test invocation/evidence and identifies exactly one next implementation PR. No modifications to working code or destructive Git operations.

## Test strategy
Diff inspection, source path existence checks, metadata consistency, explain unavailable local state if necessary.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Delete only the proposed reconciliation file from the feature branch; no runtime effects.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
