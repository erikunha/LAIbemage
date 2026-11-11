# Output Artifacts and Cross-References

## Output Artifacts

| When the user asks for... | They get... |
|---------------------|------------|
| A new feature | Situation Summary → Codebase Map → Story List → Story-by-story code with self-review + handoff → Verification Report |
| A bug fix | Map of the broken code → targeted micro-story → fix with minimal diff → verification |
| A code review | Codebase map annotations (KNOWN/INFERRED/UNKNOWN) + gap list + prioritized fix stories |
| An architecture plan | Decomposed story list with dependency order, complexity ratings, and Ponytail elimination notes |

## Cross-References

- **`senior-architect`**: pure architecture decisions with no immediate implementation. NOT for tasks where code is written in the same session.
- **`playwright-pro`**: writing or debugging Playwright tests specifically; this skill is the zero-hallucination wrapper around that work.
- **`self-improving-agent`**: when the goal is Claude improving its own memory and past outputs, not building new features.
