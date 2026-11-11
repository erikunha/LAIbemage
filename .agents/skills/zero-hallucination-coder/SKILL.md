---
name: zero-hallucination-coder
description: "Use when grounding code in verified structure: Discuss, Map, Decompose, Execute, Verify loop; no invented APIs or imports"
disable-model-invocation: true
---

# Zero-Hallucination Coder

A disciplined, senior engineering partner. The goal is code that is correct, grounded, and complete, with zero invented APIs, zero skipped steps, and zero hallucinated behavior.

## When to invoke (opt-in discipline)

This is a **deliberate, opt-in** pipeline, not the default for every edit. Reach for it when:

- The task is high-stakes or hard to undo (migrations, schema/auth changes, deployments).
- It spans existing code across multiple files, or touches external APIs, auth, databases, or state.
- The user explicitly asks to "plan carefully," "avoid hallucinated code," or "do this rigorously."

For a typo, a reformat, a docstring, or a throwaway script, skip the loop: the ceremony costs more than it saves. Anti-hallucination Rules 1-7 (below) still apply everywhere, but the five-phase loop is reserved for work that earns it.

## Before Starting

**Check for context first:** If `project-context.md` exists in the workspace, read it before asking questions. Use that context and only ask for gaps.

## Modes

- **Build from scratch**: no existing codebase. Run all five phases.
- **Extend existing code**: the relevant files must be shared before Phase 2 (Map) can run. Request only the files that matter, not the whole repo.
- **Debug or refactor**: abbreviated loop: Discuss → Map (read broken code) → Execute (targeted fix) → Verify.

## The Five-Phase Loop

Every session under this skill runs all five phases in order. Skipping phases is the primary cause of hallucinated, broken, or incomplete code.

1. **DISCUSS** - resolve end state, stack, touched code, constraints, and definition of done before planning.
2. **MAP** - build a codebase map tagged [KNOWN] / [INFERRED] / [UNKNOWN]; never code against an [UNKNOWN].
3. **DECOMPOSE** - break work into atomic stories, each implementable in one response.
4. **PONYTAIL CHECK, then EXECUTE** - kill unneeded code first, then implement one story at a time with pre-check, self-review, and handoff.
5. **VERIFY** - walk built vs planned, close gaps with micro-stories.

Example map from Phase 2:

```
CODEBASE MAP
============
[KNOWN]    UserService.ts → calls → AuthService.authenticate()
[KNOWN]    AuthService.ts → imports → jwt library (v9.x, user confirmed)
[INFERRED] UserController.ts → probably calls → UserService (assumed from naming)
[UNKNOWN]  Database connection layer → HOW auth tokens are stored → NOT VERIFIED

UNKNOWN FLAGS: must resolve before coding:
- Token storage mechanism: ask user or request db/config file
```

## Anti-Patterns (Rules 1-7, always on, even when short-circuiting)

1. **No invented APIs.** If not certain a method exists in the stated library version, ask, or write `// ⚠ ASSUMED: verify this method exists`.
2. **No assumed imports.** Every import must correspond to a package the user has confirmed exists in their project.
3. **No placeholder code.** `// TODO`, `pass`, `throw new Error("not implemented")` are forbidden unless explicitly scoped out as a new story.
4. **No skipping to the end.** Stories are sequential. No final integration before individual components work.
5. **No silent assumptions.** Every assumption gets written down and tagged [ASSUMED] or [UNKNOWN].
6. **One story per turn.** Do not batch multiple stories into one response unless they are trivially small (<20 lines each, no shared dependencies).
7. **Fresh reasoning per story.** Re-read the codebase map and previous handoff note before each new story. Do not rely on memory of what was written two stories ago.

## References

- [Discuss and Map](references/phase-discuss-and-map.md) - full Phase 1-2 protocol
- [Decompose and Ponytail](references/phase-decompose-and-ponytail.md) - story sizing, six-rung ladder
- [Execute and Verify](references/phase-execute-and-verify.md) - pre-check, self-review, handoff, report
- [Context rules and triggers](references/context-rules-and-triggers.md) - context rot, short-circuit tiers
- [Artifacts and cross-references](references/artifacts-and-cross-references.md) - output shapes, related skills
- [Credits and inspiration](references/credits-and-inspiration.md) - four upstream projects synthesized
