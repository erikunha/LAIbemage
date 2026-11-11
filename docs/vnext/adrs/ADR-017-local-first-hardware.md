# ADR-017 — CPU/MPS local-first and optional remote GPU

**Status:** Proposed for acceptance with active coding agent (product direction approved by user, not merged). **Date:** 2026-11-11.

## Context
Portfolio should work on Mac M2 and CPU-only machines without mandatory CUDA infrastructure.

## Decision
CPU reference behavior; optional MPS with memory admission and operator compatibility checks; CUDA remote worker optional by adapter and benchmark evidence.

## Alternatives considered
CUDA-only baseline, automatic deployment of expensive GPU cloud, silent fallback.

## Consequences and trade-offs
Performance varies by hardware; claims must be hardware-scoped and resource fallbacks traceable.

## Validation before acceptance
- Compare against existing `docs/adr/005–010` and any untracked `specs/` material.
- Prove at least one implementation-compatible golden path and rollback strategy.
- Preserve already shipped TypeScript features and required compatibility aliases.
- Update source docs and appropriate architecture tests in a focused PR.
