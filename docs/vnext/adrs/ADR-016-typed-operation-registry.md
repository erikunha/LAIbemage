# ADR-016 — Shared operations across Python, TS, CLI, API, Studio and MCP

**Status:** Proposed for acceptance with active coding agent (product direction approved by user, not merged). **Date:** 2026-11-11.

## Context
Multiple surfaces otherwise produce duplicate business rules and inconsistent safety policies.

## Decision
Central typed operation names/effects/schemas + Zod public contracts; Python validators generated for cross-boundary messages; tool adapters enforce authorization at application layer.

## Alternatives considered
Separate tool implementations per surface, free-form agent SQL and shell tools.

## Consequences and trade-offs
Contracts become an explicit compatibility surface; generated outputs and parity tests required.

## Validation before acceptance
- Compare against existing `docs/adr/005–010` and any untracked `specs/` material.
- Prove at least one implementation-compatible golden path and rollback strategy.
- Preserve already shipped TypeScript features and required compatibility aliases.
- Update source docs and appropriate architecture tests in a focused PR.
