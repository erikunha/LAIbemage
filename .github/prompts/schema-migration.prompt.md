---
mode: agent
description: Safely add or remove a field from AnalysisCache or PartialAnalysisCache
---

# Cache schema migration

I need to add or change a field in the analysis cache.

**Change:** {{CHANGE_DESCRIPTION}} (e.g. "add a `confidence: number` field to each ProcessedResult")
**Reason:** {{REASON}}

Please execute the full migration checklist:

## Step 1 — Increment CACHE_SCHEMA_VERSION

In `src/types.ts`, increment `CACHE_SCHEMA_VERSION` by 1 and add a comment describing
what changed in this version. The comment format is:
```
// v2: added categoriesHash field.
// v3: added confidence field to ProcessedResult.
```

## Step 2 — Update the affected interface(s)

Update `AnalysisCache` and/or `PartialAnalysisCache` in `src/types.ts` with the new field(s).
All fields must be required (non-optional) unless there is a compelling reason for optionality.

## Step 3 — Update all write sites

Find every place in `src/index.ts` that constructs an `AnalysisCache` or `PartialAnalysisCache`
object and add the new field(s). Do NOT leave the object construction with TypeScript errors —
the compiler must catch missing fields.

## Step 4 — Update all read sites

Find every place that reads from `AnalysisCache` (the `--skip-analysis` path, `runReorder`,
`runSingle`) and handle the new field — either use it or gracefully handle its absence if
reading an older cache (add a fallback default for backward compat if needed).

## Step 5 — Update partial cache resume

If the field affects the partial cache (`PartialAnalysisCache`):
- Verify `flushPartialCache` in `src/index.ts` includes the new field
- Verify the partial cache load path handles old partial caches (version mismatch → start fresh)

## Step 6 — Update tests

For every test that constructs a mock `AnalysisCache` or `PartialAnalysisCache` object,
add the new field with a reasonable test value. TypeScript will flag missing fields.

Common locations:
- `tests/analyzer/batch.test.ts`
- `tests/classifier/index.test.ts`
- Any test that imports `AnalysisCache` or `PartialAnalysisCache` from `src/types.js`

## Step 7 — Verify

Run:
```bash
pnpm run typecheck
pnpm test
```

Both must pass with zero errors before the migration is complete.

## Step 8 — Document

Update the `Known limitations` table in `ROADMAP.md` if this migration resolves a listed
issue (e.g. "analysis_results.json has no schema version"). Update `AGENTS.md` if the
schema version or cache structure is documented there.
