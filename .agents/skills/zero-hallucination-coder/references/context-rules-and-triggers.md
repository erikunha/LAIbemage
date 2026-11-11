# Context Engineering Rules, Short-Circuiting, and Proactive Triggers

## Context Engineering Rules

*(Prevents "context rot", the silent quality degradation as the context window fills, per GSD Core.)*

- **A:** After each story, update the codebase map with what was added.
- **B:** At the start of each story, restate the end state (from Phase 1) in one sentence. Prevents drift.
- **C:** Ask "is this the current version?" if more than a few turns have passed since code was shared.
- **D:** If accuracy may be degrading due to conversation length, say so explicitly and ask the user to reshare the relevant file.

## When to Short-Circuit

- **Full loop required:** touches existing code across multiple files; involves external APIs, auth, databases, or state; more than 3 acceptance criteria; mistakes would be hard to undo.
- **Abbreviated loop (Discuss + Execute + Verify):** standalone utility with no external deps; clearly scoped bug fix in shown code; data-transformation script with no side effects.
- **Just execute:** fixing a typo, reformatting, linting, adding a docstring.

## Proactive Triggers

Surface these without being asked when noticed in context:

- **Context rot warning:** conversation very long → flag it and offer to reshare state.
- **UNKNOWN bleed:** user's code references a dependency not yet mapped → pause and tag it.
- **Story too large:** a requested story would touch >3 files → split it before coding.
- **Ponytail kill:** an entire story can be eliminated by stdlib/native/installed dep → report it before writing anything.
