# Cache Schema Migration

Safely add or remove a field from `AnalysisCache` or `PartialAnalysisCache`.

**Change:** $ARGUMENTS

## Steps

### 1. Increment `CACHE_SCHEMA_VERSION` in `packages/core/src/types.ts`
Add a comment describing what changed:
```typescript
// v2: added categoriesHash field.
// v3: added <your field> to <interface>.
export const CACHE_SCHEMA_VERSION = 3; // ← increment
```

### 2. Update the interface(s) in `packages/core/src/types.ts`
Add the new field. All fields must be required (non-optional) unless backward compat demands it.

### 3. Update all write sites in `packages/core/src/index.ts`
Every object literal constructing `AnalysisCache` or `PartialAnalysisCache` must include the field.
TypeScript will error on missing fields — do not suppress with `as`.

Write sites to check (search for `AnalysisCache` and `PartialAnalysisCache` in `packages/core/src/index.ts`):
- `AnalysisCache` literal in the final cache write block
- `PartialAnalysisCache` literal inside `flushPartialCache`

### 4. Update all read sites
- `--skip-analysis` path: reads `cache.images`, may need to handle the new field
- `runReorder` in `packages/core/src/index.ts`: reads cache, add field handling
- Partial cache resume: version mismatch → start fresh (already handled by `schemaVersion` check)

### 5. Update test fixtures
Every test that constructs a mock `AnalysisCache` or `PartialAnalysisCache` needs the new field.

Search: `grep -rn "AnalysisCache\|PartialAnalysisCache" packages/core/tests/`

Common locations:
- `packages/core/tests/analyzer/batch.test.ts`
- `packages/core/tests/classifier/index.test.ts`

### 6. Verify
```bash
pnpm run typecheck   # must be zero errors
pnpm test            # all tests pass, coverage above thresholds
```

### 7. Update `CLAUDE.md`
If `CACHE_SCHEMA_VERSION` is mentioned in `CLAUDE.md`, update the version number and description.
