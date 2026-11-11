# VLN-003 — Deliver installable typed Python library with no Node dependency or mandatory GPU packages.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Deliver installable typed Python library with no Node dependency or mandatory GPU packages.

## In scope / out of scope
Create `python/visionlens` project, `src/visionlens/__init__.py`, `api.py`, `errors.py`, config, typing marker, optional extras and tests. Keep existing three service skeletons.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Use uv-managed package, hatchling or uv_build; default import must not load torch/transformers. Implement `VisionLens.local()` context manager with capability inspection and `close()`, small image metadata operation, typed MissingExtraError. Configure optional `vision`, `training`, `agents`, `server` extras; no registry publish yet.

## Contract and data effects
Python `VisionLens.local(config)` returns public client with `.capabilities()` and `.datasets.inspect(path|id)` prototype. Exception types and serializable config versioned.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
Wheel + sdist build; minimal clean venv import on CPU; package metadata excludes secrets/datasets; missing optional extra gives remediation; 3.11/3.12 smoke, no Node installed.

## Test strategy
`uv build`, `pytest`, `pyright` or `mypy`, package inspect, pip install from wheel, dependency graph check.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Remove new Python package only; existing apps unchanged.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
