# VLN-010 — Ship API-first TypeScript SDK without forcing Python, Sharp or AWS clients into consumer bundles.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Ship API-first TypeScript SDK without forcing Python, Sharp or AWS clients into consumer bundles.

## In scope / out of scope
Add `@vision-lens/sdk/client` entrypoint, typed fetch, job polling/events, abort/retry policy and errors. Preserve root/legacy exports until major migration.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Generate/validate types from OpenAPI 3.1; implement injected fetch, SSE reconnect, typed errors, pagination, ETag, idempotency key, no Node builtins in browser path. Do not publish until permissions and scope verified.

## Contract and data effects
`VisionLensClient({baseUrl,token,fetch})`, methods `.datasets`, `.jobs`, `.evaluations`, `.models`, `.agentRuns`.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
Clean browser and Node installs, no transitive heavy core in `/client` bundle, old root SDK imports still resolve, no secret printed to console.

## Test strategy
Node ESM/CJS? documented ESM policy; web bundling smoke; typed compilation; mock HTTP version skew and retries.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Keep new entrypoint experimental and/or unexport; no legacy impact.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
