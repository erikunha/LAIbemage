# VLN-012 — A bounded agent can explain dataset failures using verified evidence and safely propose experiments.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
A bounded agent can explain dataset failures using verified evidence and safely propose experiments.

## In scope / out of scope
MCP stdio tool subset, one LangGraph investigator with read/analyze/propose, approvals for paid training. No arbitrary shell/FS tools.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Tool registry wraps existing domain operations, validates snapshot scopes, cost budgets and effects outside LLM. Agent state versioned and checkpointed; report cites artifact IDs; prevention of OCR/prompt injection tested.

## Contract and data effects
Tools `inspect_dataset`, `get_evaluation`, `compare_models`, `propose_review_batch`; typed results + `evidenceRefs` and limitations.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
A test agent finds a known failure case with artifact citations; injection attempts cannot access other paths or spend budget; streaming trace and replay exports usable via Studio/API.

## Test strategy
Golden tasks, tool trajectory, denied tool access, stale approval, crash/replay, single-agent vs deterministic baseline.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Disable MCP tools and agent entrypoint; underlying domain unaffected.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
