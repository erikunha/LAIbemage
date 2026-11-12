# ADR-011 — Python-first visual ML, TypeScript-first application

**Status:** Proposed for acceptance with active coding agent (product direction approved by user, not merged). **Date:** 2026-11-11.

## Context
ADR-006 currently assigns TypeScript the application/domain core and Python service implementation. User now requests an independently publishable Python SDK and deep native ML support.

## Decision
Add one public Python package `visionlens` owning ML algorithms and in-process execution; retain Zod domain/store authority and existing TS code. The Python service skeletons become adapters. Migrate by parity, not rewrite.

## Alternatives considered
Pure Python monolith (loses current TS investments); all-TS ML (weak training ecosystem); separate repos (contract drift).

## Consequences and trade-offs
Additional bridge/packaging complexity, but strong Python research API and no sacrifice of npm/frontend. Requires new tests and staggered packaging.

## Validation before acceptance
- Compare against existing `docs/adr/005–010` and any untracked `specs/` material.
- Prove at least one implementation-compatible golden path and rollback strategy.
- Preserve already shipped TypeScript features and required compatibility aliases.
- Update source docs and appropriate architecture tests in a focused PR.
