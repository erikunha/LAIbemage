# VLN-007 — Replace degenerate all-train VisA split with defensible train/val/test design.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Replace degenerate all-train VisA split with defensible train/val/test design.

## In scope / out of scope
Audit real image IDs, duplicates and grouping fields; generate immutable split with nonempty partitions and class support or explicit unsupported exceptions.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Use actual product object/batch provenance where available. For VisA if no capture session IDs, use deterministic per-image split guarded by near-duplicate and label overlap checks; disclose that it cannot prove acquisition-level independence. For anomaly detection preserve appropriate normal-only training policy by task. Lock test hash before model selection.

## Contract and data effects
`SplitManifest` with `strategy`, `seed`, `partitionIds`, `classCounts`, `groupBasis`, `leakageAudit`, `limitations`, `sha256`.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
All three partitions nonempty, mutually exclusive, each eligible class has documented support, duplicate leakage near zero or unresolved warnings, data license present; any failure is blocked/inconclusive, never silently all-train.

## Test strategy
Degenerate group, rare class, duplicate asset, image mask pairing, two-seed reproducibility, dataset hash drift.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Keep original 700-set run as historical regression artifact and introduce new named suite ID.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
