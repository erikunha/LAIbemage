---
name: focused-fix
description: "Use when fixing or debugging a feature or module end-to-end: systematic deep-dive repair across its files"
disable-model-invocation: true
---

# Focused Fix: Deep-Dive Feature Repair

Systematic repair of an entire feature or module: trace every dependency, read logs, check tests, map the full dependency graph, then fix in strict order and verify end-to-end.

## When to Use

Activate when the user asks to fix, debug, or make a specific feature/module/area work. Key triggers:
- "make X work"
- "fix the Y feature"
- "the Z module is broken"
- "focus on [area]"
- "this feature needs to work properly"

This is NOT for quick single-bug fixes (use systematic-debugging for that). This is for when an entire feature or module needs systematic repair: tracing every dependency, reading logs, checking tests, mapping the full dependency graph.

## The Iron Law

```
NO FIXES WITHOUT COMPLETING SCOPE → TRACE → DIAGNOSE FIRST
```

If you haven't finished Phase 3, you cannot propose fixes. Period.

**Violating the letter of these phases is violating the spirit of focused repair.**

## Core Workflow

Follow the 5 phases IN ORDER; full per-phase steps, checklists, output formats and the escalation rule are in [references/protocol-phases.md](references/protocol-phases.md).

| Phase | Key Action | Output |
|---|---|---|
| SCOPE | Read every file, map entry points | Feature manifest |
| TRACE | Map inbound + outbound dependencies | Dependency map |
| DIAGNOSE | Check code, runtime, tests, logs, config | Diagnosis report |
| FIX | Fix in order: deps → types → logic → tests → integration | Fix log per issue |
| VERIFY | Run all tests, check consumers, summarize | Completion report |

If a fix breaks something else, return to DIAGNOSE. If 3+ fixes create new issues, STOP and question the architecture with the user.

For a UI feature with shared state (a store, context or reducer), DIAGNOSE includes a click-path audit: map what every state action sets and silently resets, then trace each control's handler in call order against what its label promises. Read [references/click-path-audit.md](references/click-path-audit.md) for the six patterns and the finding format.

## Example

Output after each fix in Phase 4:

```
FIX #1:
  File: auth/service.ts:45
  Issue: signToken called with wrong argument order
  Change: swapped (expiresIn, payload) to (payload, expiresIn)
  Test: auth.test.ts → PASSES
```

## References

- [Protocol phases](references/protocol-phases.md) - full five-phase procedure, checklists, escalation
- [Red flags and rationalizations](references/red-flags-and-rationalizations.md) - stop signals, excuses, anti-patterns table
- [Click-path audit](references/click-path-audit.md) - state-action map, per-control trace, six ordering patterns
