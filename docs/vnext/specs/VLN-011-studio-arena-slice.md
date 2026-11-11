# VLN-011 — A clear public visual demo of quality/cost/latency/evidence, backed by actual recorded artifacts.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
A clear public visual demo of quality/cost/latency/evidence, backed by actual recorded artifacts.

## In scope / out of scope
Build Next.js with dataset list/details, read-only sample explorer, evaluation compare, job progress, navigation and errors. Review/edit later.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Use existing API/domain contracts, virtualized image grid, cached thumbnails, URL filters, accessible metric table and per-class confusion. Show "replay" vs "live" source label. Ensure one screen tells the engineer what improved and what regressed.

## Contract and data effects
API GET dataset/evaluation/models/jobs, SSE jobs; no direct Python imports in frontend.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
Demo loads on desktop/mobile, keyboard paths tested, no fake metrics, 10k item virtual list stays responsive in target browser, screenshots are based on working application.

## Test strategy
Playwright E2E, axe/a11y, performance budget, error/empty/loading states, structured artifact fixture.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Feature flag read-only Studio; CLI/engine independent.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
