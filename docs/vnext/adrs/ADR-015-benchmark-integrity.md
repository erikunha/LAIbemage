# ADR-015 — Holdout, split provenance and calibrated quality gates

**Status:** Proposed for acceptance with active coding agent (product direction approved by user, not merged). **Date:** 2026-11-11.

## Context
Existing 700-image VisA baseline is real but all items fell into train, so it is not a held-out generalization measure.

## Decision
Keep historical regression result; add leakage-resistant train/validation/test suite with disjoint samples and explicit limitations. Train/AL never touch test labels. Record calibration and cost separately.

## Alternatives considered
Publish 0.9795 macro F1 as model performance in real world (unsupported); random split without duplicate controls; fabricated acquisition groups.

## Consequences and trade-offs
Tighter scientific gate can postpone a public comparison but protects credibility and real training results.

## Validation before acceptance
- Compare against existing `docs/adr/005–010` and any untracked `specs/` material.
- Prove at least one implementation-compatible golden path and rollback strategy.
- Preserve already shipped TypeScript features and required compatibility aliases.
- Update source docs and appropriate architecture tests in a focused PR.
