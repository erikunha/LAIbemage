---
mode: ask
description: Add a new image category to the taxonomy
---

# Add a new image category

I want to add a new image category to Vision Lens.

**Category name:** {{CATEGORY_NAME}}
**Description:** {{CATEGORY_DESCRIPTION}}
**Should it be immune (never overridden by temporal consensus)?** {{IMMUNE}}
**Should it be overridable (can be overridden by cluster majority)?** {{OVERRIDABLE}}
**Should it be pinned to the end of the output?** {{PINNED_LAST}}

Please:

1. Add the category to `examples/categories.json` (name + description) — the name MUST match `/^[a-z][a-z0-9_]*$/` (Zod enforced; verify before committing)
2. If immune, add to the `immune` array
3. If overridable, add to the `overridable` array
4. If pinned, add to the `pinnedLast` array in the correct position
5. Add the category name to the test fixture in any test that uses a hardcoded category list (include `concurrency: 1` in any `Config` fixture; include `confidence: 0, extractedText: null` in any `AnalysisResult` fixture)
6. Show me a brief diff of all changed files
