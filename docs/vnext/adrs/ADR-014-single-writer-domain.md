# ADR-014 — Preserve TypeScript SQLite domain store and immutable artifacts

**Status:** Proposed for acceptance with active coding agent (product direction approved by user, not merged). **Date:** 2026-11-11.

## Context
Existing branch implements 14 entities, SQLite migrations, lineage and legacy importer, while Python ML needs persistence.

## Decision
TS store remains single metadata writer initially; Python writes content-addressed ML artifacts and returns manifests. MLflow holds experiment telemetry; domain references it.

## Alternatives considered
Replace with PostgreSQL before use; let Python and TS write same SQLite concurrently without coordination.

## Consequences and trade-offs
Less direct Python store access initially, but no duplicate persistence semantics; later add API-backed adapter.

## Validation before acceptance
- Compare against existing `docs/adr/005–010` and any untracked `specs/` material.
- Prove at least one implementation-compatible golden path and rollback strategy.
- Preserve already shipped TypeScript features and required compatibility aliases.
- Update source docs and appropriate architecture tests in a focused PR.
