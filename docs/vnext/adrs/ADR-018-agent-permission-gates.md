# ADR-018 — Evidence-first agent with tool effects, budgets and human approvals

**Status:** Proposed for acceptance with active coding agent (product direction approved by user, not merged). **Date:** 2026-11-11.

## Context
Vision datasets may carry untrusted OCR/metadata; a generic agent can be induced to exfiltrate or spend.

## Decision
One bounded LangGraph investigator first, tool-effect tiers outside model, approvals with TTL/scope, artifact citations, evals against deterministic baseline. Multiagents research-gated.

## Alternatives considered
Autonomous shell tools, blanket filesystem access, unsupervised training/promotion, multiagent swarm for show.

## Consequences and trade-offs
Extra policy engineering but reduced risk and measurable agent effectiveness.

## Validation before acceptance
- Compare against existing `docs/adr/005–010` and any untracked `specs/` material.
- Prove at least one implementation-compatible golden path and rollback strategy.
- Preserve already shipped TypeScript features and required compatibility aliases.
- Update source docs and appropriate architecture tests in a focused PR.
