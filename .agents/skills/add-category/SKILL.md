---
name: add-category
description: Use when a user wants to add a new image category to a categories.json taxonomy, configure whether that category is immune, overridable or pinned last, or understand how category settings change Vision Lens classification output.
---

# Skill: Add Category

**Domain:** Category taxonomy management for Vision Lens

## When to use this skill

Use this skill when a user wants to:

- Add a new image category to an existing `categories.json` file
- Configure whether the category is immune, overridable, or pinned
- Understand the impact of their category settings

## Steps

### 1. Gather requirements

Ask the user:

- What is the category name? (must be `lowercase_snake_case`)
- What is the description? (1 sentence, used directly in the GPT prompt)
- Is it **immune**? (should temporal consensus never override it?)
- Is it **overridable**? (should it be overridden by cluster majority if ambiguous?)
- Should it be **pinned last** in the output?

### 2. Validate category name

The name must match `/^[a-z][a-z0-9_]*$/`. Reject names with spaces, capitals, or hyphens.

### 3. Apply to categories.json

Edit the user's target `categories.json` (default: `examples/categories.json`):

- Append to `categories` array: `{ "name": "...", "description": "..." }`
- If immune: append to `immune` array
- If overridable: append to `overridable` array
- If pinned: append to `pinnedLast` array (before `unknown` if present)

### 4. Verify no test fixtures need updating

Search `tests/` for hardcoded category arrays. If found, add the new category there too.
Ensure all `Config` fixtures include `concurrency: 1` and all `AnalysisResult` fixtures include
`confidence: 0` and `extractedText: null`.

If the new category requires a new field in `AnalysisResult` (rare — avoid unless truly domain-agnostic),
increment `CACHE_SCHEMA_VERSION` in `src/types.ts` and add a migration step in `src/utils/migrate.ts`.

### 5. Confirm

Show the user the diff and remind them:

- The GPT prompt is built dynamically — no code changes needed
- Re-run `pnpm test` to ensure nothing broke
- The new category will take effect on the next Vision Lens run

## Example output (categories.json diff)

```diff
  "categories": [
    { "name": "kitchen", "description": "Any view from inside a kitchen" },
+   { "name": "roof", "description": "Roof surface, tiles, gutters, or chimney" }
  ],
  "pinnedLast": ["common_area", "conversation_screenshot", "payment_receipt", "unknown"],
  "immune": ["payment_receipt", "conversation_screenshot"],
  "overridable": ["unknown", "common_area"]
```
