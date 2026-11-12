# VLN-002 — Approve architecture amendment that makes Python the first-class ML library and keeps TS app/domain spine.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Approve architecture amendment that makes Python the first-class ML library and keeps TS app/domain spine.

## In scope / out of scope
Compare ADR-006, current `services/` skeleton, `packages/contracts`, `@vision-lens/sdk` exports and `packages/core` provider adapters; write superseding ADR-011.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Document ownership for datasets, embeddings, preprocessing, training, eval, API, worker, store; specify exact migration and package import rules. Do not rename service directories or break CI.

## Contract and data effects
Defines package `visionlens`, `@vision-lens/sdk/client`, protocol `visionlens.worker.v1` (all pending registry and code review).

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
Architecture diagram + import boundary table + inverse dependencies + side-effect permission table accepted by maintainer; package names checked for conflicts before publishing.

## Test strategy
Static architecture boundary tests and a sample serialized JSONL operation validated in TS and Python in next ticket.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Mark ADR superseded, keep existing runtime stable.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
