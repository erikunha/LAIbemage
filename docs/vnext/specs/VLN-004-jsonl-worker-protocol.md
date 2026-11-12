# VLN-004 — A reliable versioned bridge between existing TypeScript orchestration and Python runtime.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
A reliable versioned bridge between existing TypeScript orchestration and Python runtime.

## In scope / out of scope
Add worker/launcher with `hello`, `request`, `progress`, `result`, `error`, `cancel`; typed frames and bounded IO; no dataset logic migration yet.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Long-lived subprocess with closed inherited stdin except request pipe; use stdout only for JSONL, stderr for logs; handshake validates version/extra/device; enforce max frame bytes, deadline, request correlation, graceful SIGTERM and kill on timeout. Maintain per-request sequence, output artifact refs and typed error codes.

## Contract and data effects
`visionlens.worker.v1` frame schema under `contracts/proposed` must be ratified into TS contract package; examples `examples/worker-request.json` and `examples/worker-result.json`.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
10 concurrent requests correlated correctly; malformed JSON rejected without crash; protocol mismatch fails before paid call; cancellation exits worker; no stdout contamination.

## Test strategy
Golden JSONL parity TS/Python; deliberate crash, slow worker, giant line, malformed frame, missing optional dependencies.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Feature flag disables Python bridge; legacy TS path unaffected.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
