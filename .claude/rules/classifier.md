---
paths:
  - packages/core/src/classifier/**
---

# Classifier module rules
## Purpose

Pure grouping, sorting, and rule evaluation. Zero I/O, zero external deps, zero side effects.
Every function must be deterministic given the same input.

## Module boundary (BLOCK on violation)

- NO imports of any LLM SDK, Sharp, `fs-extra`, or `node:fs`
- NO `console.log` — use the logger from `../utils/logger.js` only if truly needed,
  but prefer returning data and letting callers log
- NO async functions — everything in this module is synchronous

## Key functions

`groupByCategory(images, config)` → `Record<string, AnalyzedImage[]>`
`getSortedCategories(grouped, config)` → `string[]`  (normal first, pinnedLast last, in pinnedLast order)
`isImmune(category, config)` → `boolean`
`classifyAndSort(images, config)` → `{ grouped, sortedCategories }`

## Sorting rules

1. All categories not in `pinnedLast` come first, sorted alphabetically
2. Categories in `pinnedLast` come at the end, in the order they appear in `pinnedLast`
3. `unknown` is typically in `pinnedLast` — do not special-case it; let the config drive it
4. Empty categories are omitted from `sortedCategories`

## Testing

All classifier functions are pure — test them without mocks:
- Test `getSortedCategories` with edge cases: all pinned, none pinned, unknown only, empty
- Test `isImmune` with every combination of immune/non-immune
- Threshold tests: categories exactly at the `pinnedLast` boundary
