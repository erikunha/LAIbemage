# Phase 4: EXECUTE and Phase 5: VERIFY

## Phase 4: EXECUTE

**Goal:** Implement exactly one story at a time with no hallucinated dependencies. *(Ralph + GSD Core principle)*

**Step A: Pre-implementation check:**
```
STORY [N]: [Title]
Pre-check:
- All dependencies from story list: CONFIRMED ✓ / MISSING ✗
- All APIs/methods this code calls: KNOWN ✓ / ASSUMED ⚠ / UNKNOWN ✗
- Files this touches: [list them]
```
If any UNKNOWN exists, stop and resolve it before writing code.

**Step B: Write the code:**
- Complete, runnable implementation: no placeholders, no `// TODO`, no `...rest of implementation`.
- Every function fully implemented or explicitly out of scope with a written reason.
- Imports must be real: never invent package names.
- If a method's existence is uncertain: `// ⚠ ASSUMED: verify this method exists in your version`.

**Step C: Self-review:**
```
SELF-REVIEW
===========
☑ Does this do exactly what Story [N] specifies?
☑ Are there any invented method names or APIs?
☑ Are there any assumed behaviors that depend on unseen code?
☑ Does this break anything in the codebase map?
☑ Are the acceptance criteria from Story [N] met?
Verdict: READY TO TEST / NEEDS REVISION, [reason]
```

**Step D: Handoff note:**
```
HANDOFF
=======
What was built: [one sentence]
How to test: [exact steps, not "it should work"]
What to watch for: [edge cases or fragile assumptions]
Next story: Story [N+1], [title]
```

Do not proceed to the next story until the user confirms the current one passes.

## Phase 5: VERIFY

**Goal:** Before declaring done, walk through what was built vs what was planned. *(GSD Core principle)*

```
VERIFICATION REPORT
===================
Original end state (from Phase 1): [restate it]
Stories completed: [N/N]

Story [N]: [Title]
  Planned acceptance: [from Phase 3]
  Actual behavior: [what the code actually does]
  Gap: NONE / [describe gap]
  Status: PASS / NEEDS REVISION

Outstanding issues: [any gaps, assumptions, deferred items]

OVERALL: COMPLETE / NEEDS WORK, [summary]
```

If any story has a gap, write a micro-story to close it and run Phase 4 again for that gap only.
