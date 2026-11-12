# VLN-006 — Expose Python ML as a new option without altering old `vision-lens` behavior.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Expose Python ML as a new option without altering old `vision-lens` behavior.

## In scope / out of scope
Add application service PythonWorkerAdapter, config route, logs/metrics; preserve `@vision-lens/core` and `@vision-lens/sdk` historical exports.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Route only new `vision.embed` operation to Python. Do not replicate ML calculations in TypeScript. Register capability after worker health handshake. Keep CLI compatibility bin and no silent provider changes.

## Contract and data effects
`VisionOperationPort` with `runEmbedding` returning versioned artifact reference, typed result and no absolute paths in external API.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
Legacy test baseline unchanged; CLI Python route (opt-in) produces same operation result envelope; unavailable Python yields helpful diagnostic; no paid API fallback by default.

## Test strategy
Mock bridge, real CPU bridge integration, legacy CLI snapshots, import-boundary gate.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Flip feature flag to TS-only / disable Python operation.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
