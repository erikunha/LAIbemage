# VLN-009 — Prove actual ML training and reproducible model comparison, not few-shot prompt reuse.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Prove actual ML training and reproducible model comparison, not few-shot prompt reuse.

## In scope / out of scope
Frozen encoder embeddings + scikit-learn logistic regression; MLflow artifact/model card, resume; optional PyTorch head.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Train only on train split, tune via validation, lock test evaluation, seed and checkpoint, record preprocessing hash. CPU is default and MPS experimental. Compare to zero-shot + cloud VLM under equivalent protocol and report accuracy/cost/latency.

## Contract and data effects
`TrainRecipe` and `ExperimentReport` linked to immutable dataset/model artifacts with `trainDatasetHash` and `validationDatasetHash`.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
Training on a real licensed dataset changes model parameters and produces a digest-pinned checkpoint; independent holdout run; reproducibility tolerance recorded; model registry can load predicted class map.

## Test strategy
Overfit tiny fixture, seed repeat, label leakage rejection, cold/warm inference, checkpoint resume and cancel.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Keep original VLM/embedding baseline, unregister candidate model.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
