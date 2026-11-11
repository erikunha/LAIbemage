# VLN-008 — Publish a scientifically interpretable comparison with a truly unseen test set.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Publish a scientifically interpretable comparison with a truly unseen test set.

## In scope / out of scope
Add evaluation reports with per-class metrics, confusion, calibration, latency, actual/estimated cost and reproducibility tuple; compare models on same sample IDs.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Score explicit prediction artifacts; missing predictions count as failed; ECE from calibration set only; confidence intervals from bootstrap/group-aware method; report dataset license, model version, device, split digest, costs and limitations. Regression gates run only comparable tuples.

## Contract and data effects
Evaluation report JSON with `protocolVersion`, `testSplitFingerprint`, `metrics`, `perClass`, `cost`, `latency`, `limitations`, `artifactRefs`, `manifestSha256`.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
Report flags prior all-train baseline as non-holdout; no percent accuracy without N and subset; macro-F1 and ECE verified with oracle fixture; gitignored huge outputs retain committed manifest pointers.

## Test strategy
Hand-computed confusion fixture, no-samples error, missing predictions, calibrator provenance, changed dataset fingerprint refusal.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Old reports remain readable; new suite/version used for new claims.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
