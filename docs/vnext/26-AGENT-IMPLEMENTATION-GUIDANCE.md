# Agent implementation protocol for Codex / Claude Code

## Mission

Implement Vision Lens vNext incrementally and safely, recognizing that `feat/visual-lens` already contains major code and research. Do not restart or replace that work because this ZIP is newer. Focus on contract-aware additions, reproducible evidence and end-to-end slices.

## Mandatory first action

Read `00-ADOPTION-NO-OVERWRITE.md` and run read-only repo inventory; inspect local `specs/` (untracked), current branch, all dirty/untracked work, PRs and CI. Output a reconciliation table with file paths and commit references. No editing until baseline established.

## Definition of a task

Every task must include `ID`, user outcome, in/out scope, source evidence, dependencies, contracts touched, storage effects, security and data-licensing classification, performance/compute budget, test plan, acceptance criteria, rollback, instrumentation and PR diff scope. Prefer a single self-contained feature PR to "architecture rewrite".

## Branch discipline

Use new feature branch off active work (not automatically `main`). Preserve others' commits and worktrees. Do not force push, rebase or delete on assumption. Before editing shared contract file, check current SHA and agent ownership. If conflicts or local edits are detected, stop that specific edit and make a non-destructive proposal; continue on unaffected tasks.

## Execution checklist

1. Write failing test or reproducible failing script.
2. Make minimum change that satisfies API and behavior.
3. Check multi-language parity and existing legacy CLI tests.
4. Run docs/codegen and check snapshots only if inputs deliberately changed.
5. Document actual measurements and unknowns; do not invent benchmark performance.
6. Update ADR/spec status and changelog in same PR.
7. Review diff for secrets and unrelated changes; explain rollback.

## Handoff prompt

> Read `README.md`, `00-ADOPTION-NO-OVERWRITE.md`, `01-REPO-STATE-2026-11-11.md`, `02-ARCHITECTURE-DECISION.md`, `23-RELEASE-ROADMAP.md` and the next selected spec. Inspect the full local working tree before any changes. Reconcile vNext with already-completed work on the active branch; produce a KEEP/AMEND/DEFER/CONFLICT matrix and propose an ADR for Python-first ML package ownership. Do not reset, overwrite or replace existing 001–014 specs or implementations. Implement only one reviewed, independently verifiable vertical slice after baseline tests. Make measured vs proposed results explicit.

## Developer-quality bar

Do not reward volume of agent-generated code. Reward evidence, safe migrations, scientific evaluation, stable interfaces, accessibility, reproducible measurements, tests and low operational burden.
