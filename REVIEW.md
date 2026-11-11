# REVIEW.md

What a reviewer reports on a diff in this repository. The `.claude/agents/code-reviewer.md`
agent and every human or agent review follow this file. It is a contract about what blocks a
merge, not a summary of the toolchain.

## Severity

- **CRITICAL**: breaks production, security or data integrity, or trips a hard gate. Examples: a
  provider SDK imported outside its allowed directory, a secret or a real API key in a log line
  or a fixture, a gate edited so it passes, a cache written without the atomic rename.
- **IMPORTANT**: a real defect a maintainer would fix before merging. Examples: wrong behavior on
  a reachable path, a fix with no regression test, a gate that fails open, an accuracy claim with
  no reproduction record, a doc or diagram that now contradicts the code.
- **MINOR**: optional polish that does not block the merge. Report at most five in a review, and
  none at all when there is a CRITICAL or IMPORTANT finding in the same file.

The categories below decide what blocks the merge. Severity follows consequence, not the verdict
you want.

## What blocks

Only a finding in one of these six categories blocks the merge:

1. Correctness: wrong behavior on a reachable path.
2. Security: a leaked credential, an untrusted value reaching a shell, a path or a sink, an
   unescaped model output reaching HTML, a plugin path not resolved to an absolute path.
3. Data integrity: a cache or store write that is not atomic, a migration whose bytes changed
   after it was applied, a cache shape change without the version bump, a prediction that
   overwrote an annotation.
4. Test validity: a fix with no regression test, a test that passes for the wrong reason, an
   assertion weakened to go green, a fixture that hides a missing field.
5. Spec or plan compliance: the change does not do what the spec, the plan or the PR description
   says, or it does more than they authorize.
6. Documentation truthfulness: a doc that states a number, a path or a command that does not hold.
   This repository tracks measured benchmark evidence, so a false number in a doc is not a typo:
   it poisons the evidence chain that every other claim rests on.

Style, naming, formatting taste and refactors the change does not need never block, whatever the
severity badge says. Report at most five MINOR findings in a review.

A finding without a `file:line` on the head commit and a statement of what breaks, and when, is
dropped.

## Always check

- A moved path: the CI `paths:` filters and every glob that names a location (the workflow
  triggers, the include globs in `vitest.config.ts`, the `files` globs in `eslint.config.js`, the
  `lint-staged` patterns) must still match the new location. A filter left on an old path
  evaluates to "unchanged" and skips silently. The mutation workflow still names the pre-monorepo
  `src/classifier/**`, which is exactly this failure: the job no longer runs on the files it
  covers.
- A weakened gate: a lowered threshold in `vitest.config.ts` or `stryker.config.mjs`, a new entry
  in the coverage exclusion list, a `continue-on-error` added to a CI step, an audit downgraded to
  advisory, code reshaped to evade a checker.
- A fix without the test that fails before it and passes after it.
- The module-boundary rule: no provider SDK outside `packages/core/src/analyzer/providers/**`,
  with the one documented carve-out, and the table in `AGENTS.md` kept in step with the code.
- The ESM rule: every relative import carries the `.js` extension (ADR-001).
- The logger rule: `console.*` appears only in `packages/core/src/utils/logger.ts` and
  `packages/core/src/utils/progress.ts`, so `--quiet` and `--json` keep working.
- An accuracy claim with no reproduction record: per ADR-008 the real-data benchmark is the only
  source of an accuracy number, and every metric artifact carries the dataset snapshot, the split
  seed, the config fingerprint, the model version and the environment. A number without that
  tuple is a hypothesis and blocks.
- A migration that changed bytes after being applied: the ledger records the hash of each applied
  migration file, and an edited history is refused rather than re-run. A migration that rewrites
  data also requires a MAJOR contracts bump.
- An evidence artifact that moved or was rewritten: the tracked splits, predictions and baselines
  under `benchmarks/` are reviewed artifacts. A baseline that moves is a decision, not a side
  effect of a run.
- The store and cache invariants: atomic write of the cache, the `CACHE_SCHEMA_VERSION` bump in
  `packages/core/src/types.ts` when the cache shape changes, and the schema guard on the parsed
  batch envelope.
- A credential: no real API key, token or dataset binary in source, fixtures, logs or the tree.

## Skip

- Anything a gate already reports: formatting, lint, import order, types, the provider-SDK
  boundary, the coverage thresholds, the benchmark gate, mutation. A reviewer must not re-report
  what a gate already reports. Name the gate and let it speak instead.
- Generated and binary files: `dist/`, `coverage/`, `docs/api/`, `reports/`,
  `benchmarks/results/`, and the dataset directories under `datasets/`. The tracked registry
  `datasets/registry.json` is not generated and is not skipped.
- Issues the diff does not touch. Mention one only when the diff makes it newly reachable.
- Style preferences, naming taste and acronym capitalization.
- The maintainer's local environment: untracked spec material under `specs/` and `.specify/`
  (ADR-010), and anything covered by a global git ignore.

## Verdict

The verdict follows the convention in `.claude/agents/code-reviewer.md`:

- **PASS**: every check ran and passed. Safe to merge.
- **WARN**: no blocking finding, but the reviewer wants the maintainer to see something: a lint
  warning, coverage that dropped, a missing regression test, a console call outside the
  sanctioned sinks, a commit message that does not follow the convention, a P1 security concern.
- **BLOCK**: at least one finding in a blocking category. Not mergeable until every blocking
  finding is answered.

The verdict is the reviewer's conclusion, never a substitute for CI. CI stays the authoritative
gate, and a PASS never overrides a red job.
