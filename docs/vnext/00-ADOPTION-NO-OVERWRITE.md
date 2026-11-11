# Adoption protocol: do not erase work already in progress

This package is a **new design baseline**, not a wholesale repository replacement. The user's coding agent has already started the pivot. Even the public branch may lag the agent's local work.

## Required handoff sequence

1. Confirm the actual repository path and branch. Record `git status --short`, `git branch -vv`, `git log -8 --oneline`, `git diff --stat`, untracked filenames, existing specs directories and unmerged PRs. Do not assume `main` is the working branch.
2. Take a read-only inventory of `packages/`, `apps/`, `services/`, `docs/`, `specs/`, tests and CI. The public `feat/visual-lens` already contains substantive work.
3. Produce `docs/migration/vision-lens-vnext-reconciliation.md` **in a new branch**: per module list `KEEP`, `AMEND`, `DEFER`, `SUPERSEDE`, `CONFLICT`, with code pointers and test evidence. If a doc exists locally and is more current, retain it and reconcile the new decision into it.
4. Make an explicit compatibility matrix for CLI flags, SDK exports, store migrations, dataset manifests, model artifacts and the Python smoke services. Record all deltas that may break users.
5. Introduce an ADR to express Python ownership of **ML runtime**, not of all domain entities. Keep current TS contracts and stores functional.
6. Divide implementation into small PRs with contracts/tests and rollback. A single PR must not combine renaming packages, Python migration, new Studio and new ML algorithms.

## Read-only inspection commands

```bash
git status --short
git branch -vv
git log --all --oneline --decorate -20
git diff --stat
git ls-files 'specs/**' 'docs/**' 'services/**'
pnpm --filter @vision-lens/contracts test
pnpm --filter @vision-lens/core test
pnpm --filter @vision-lens/cli test
```

Run tests only after checking available dependencies and potential side effects; reports must distinguish executed vs not executed. Do not run dataset downloads or paid model calls as routine inspection.

## Safe application strategy

- Introduce the canonical package in `docs/vnext/` initially, not as blind replacements for `README.md`, `AGENTS.md`, `ROADMAP.md`, or `docs/adr/006-monorepo-ts-python.md`.
- Compare the existing local `specs/001–014` (untracked per current ADR-010) against this package. Existing completed tasks remain **DONE**; new tasks acquire unique IDs (`VLN-...`) rather than reusing old numbers.
- Avoid storing customer images, model weights, huge datasets and API keys in Git. Datasets remain content-hashed and license-aware.
- Change the public PyPI/npm names only after registry availability/license verification. `@vision-lens/sdk` is already present locally but is not a published lightweight HTTP SDK yet.
- No destructive database migrations without backup, forward-only migration verification and a tested restoration procedure.
- If a decision conflicts with a shipped API or accepted ADR, write a new superseding ADR and prove migration, rather than silently revising history.

## Design decisions that *change* versus 2026-11-10

| Previously proposed | Current vNext decision | Effect |
|---|---|---|
| TypeScript domain engine + three Python *service-only* skeletons | **Python-first public vision/ML library**, with existing TS app/domain backbone | Add `python/visionlens` incrementally; keep `services/` adapters |
| TypeScript SDK primarily re-exporting heavy core | Split lightweight typed remote SDK from compatibility/fat in-process exports | Preserve old APIs during transition; publish stable paths by major version |
| Python only behind JSON-lines services | Python users can execute local ML in-process; JS app uses worker protocol | No forced HTTP server to use Python SDK |
| Existing VisA 700-item accuracy as product success | Treat as regression baseline; **no holdout**, not generalization proof | Gate comparisons on leakage-resistant holdout |
| `vision-lens` and `@vision-lens/*` fully public | On public branch, packages are marked unpublished, some private | Registry check/publishing gates before claiming availability |
| Many libraries immediately | Begin with one Python distribution `visionlens` and optional extras | Avoid dependency explosion, preserve small installs |

## Completion criterion

The developer can explain precisely what remains implemented in TS and what moves to Python, with one green end-to-end vertical slice, no lost commits, no accidental API breaks and an archived evidence report.
