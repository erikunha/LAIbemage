# ADR-013 — Versioned JSONL worker for local cross-language execution

**Status:** Proposed for acceptance with active coding agent (product direction approved by user, not merged). **Date:** 2026-11-11.

## Context
CLI, Fastify and Studio need Python ML while retaining Node domain and job orchestration. Serializing full images as JSON is inefficient.

## Decision
Long-lived JSONL worker with request/hello/progress/result/error/cancel envelopes, hashed asset references, resource limits and structured error codes; remote HTTP adapter optional.

## Alternatives considered
Per-image Python subprocess (startup overhead); unbounded gRPC framework early (complexity); shared SQLite dual writes (corruption risk).

## Consequences and trade-offs
Need robust process lifecycle, cancellation, schema parity, stdout discipline and worker health checks.

## Validation before acceptance
- Compare against existing `docs/adr/005–010` and any untracked `specs/` material.
- Prove at least one implementation-compatible golden path and rollback strategy.
- Preserve already shipped TypeScript features and required compatibility aliases.
- Update source docs and appropriate architecture tests in a focused PR.
