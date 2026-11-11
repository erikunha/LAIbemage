# Focused Fix: Red Flags, Rationalizations, Anti-Patterns

## Red Flags: STOP and Return to Current Phase

If you catch yourself thinking any of these, you are skipping phases:

- "I can see the bug, let me just fix it" → STOP. You haven't traced dependencies yet.
- "Scoping is overkill, it's obviously just this file" → STOP. That's always wrong for feature-level fixes.
- "I'll map dependencies after I fix the obvious stuff" → STOP. You'll miss root causes.
- "The user said fix X, so I only need to look at X" → STOP. Features have dependencies.
- "Tests are passing so I'm done" → STOP. Did you run consumer tests too?
- "I don't need to check env vars for this" → STOP. Config issues masquerade as code bugs.
- "One more fix should do it" (after 2+ cascading failures) → STOP. Escalate.
- "I'll skip the diagnosis report, the fixes are obvious" → STOP. Write it down.

**ALL of these mean: Return to the phase you're supposed to be in.**

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "The feature is small, I don't need all 5 phases" | Small features have dependencies too. Phases 1-2 take minutes for small features. Do them. |
| "I already know this codebase" | Knowledge decays. Trace the actual imports, don't rely on memory. |
| "The user wants speed, not process" | Skipping phases causes rework. Systematic is faster than thrashing. |
| "Only one file is broken" | If only one file were broken, the user would say "fix this bug", not "make the feature work." |
| "I fixed the tests, so it works" | Tests can pass while consumers are broken. Verify Phase 5 fully. |
| "The dependency map is too big to trace" | Then the feature is too big to fix without tracing. That's exactly why you need it. |
| "Root cause is obvious, I don't need to confirm" | "Obvious" root causes are wrong 40% of the time. Confirm with evidence. |
| "3 cascading failures is normal for a big fix" | 3 cascading failures means you're patching symptoms of an architectural problem. |

## Anti-Patterns: NEVER do these

| Anti-Pattern | Why It's Wrong |
|---|---|
| Starting to fix code before mapping all dependencies | You'll miss root causes and create whack-a-mole fixes |
| Fixing only the file the user mentioned | Related files likely have issues too |
| Ignoring environment variables and configuration | Many "code bugs" are actually config issues |
| Skipping the test run phase | You can't verify fixes without running tests |
| Making changes outside the feature folder without explaining why | Unexpected side effects confuse the user |
| Fixing symptoms in consumer files instead of root cause in feature | Band-aids that break when the next consumer appears |
| Declaring "done" without running verification tests | Untested fixes are unverified fixes |
| Changing the public API without updating all consumers | Breaks everything that depends on the feature |

## Related Skills

- **`superpowers:systematic-debugging`**: Use within Phase 3 for root-cause tracing of individual complex bugs
- **`superpowers:verification-before-completion`**: Use within Phase 5 before claiming the feature is fixed
- **`scope`**: If you need to understand blast radius before starting, run scope first then focused-fix
