# ADR-012 — Python native API + lightweight TypeScript client with compatibility

**Status:** Proposed for acceptance with active coding agent (product direction approved by user, not merged). **Date:** 2026-11-11.

## Context
Current `@vision-lens/sdk` reexports the heavier TS core; user wants Python PyPI and npm library.

## Decision
Keep old root exports during transition, add `@vision-lens/sdk/client` lightweight HTTP client, and add `visionlens` Python local SDK. Version each compatibility surface and publish only after registry checks.

## Alternatives considered
Replace npm SDK immediately (breaks consumers); duplicate Python inference logic in TS (semantic drift).

## Consequences and trade-offs
Staged semver support, package smoke tests and explicit deprecation plan required.

## Validation before acceptance
- Compare against existing `docs/adr/005–010` and any untracked `specs/` material.
- Prove at least one implementation-compatible golden path and rollback strategy.
- Preserve already shipped TypeScript features and required compatibility aliases.
- Update source docs and appropriate architecture tests in a focused PR.
