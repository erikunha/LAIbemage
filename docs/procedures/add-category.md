# Add a category

Covers adding an image category to a `categories.json` taxonomy and configuring its `immune`,
`overridable` and `pinnedLast` behavior, plus two related recipes that used to live in separate
command guides: setting up a brand-new domain taxonomy from scratch, and migrating the analysis
cache schema when a category change requires it. Use it whenever the taxonomy changes or a new
image domain is being brought online.

## When to use

- A new image category is added to an existing `categories.json`
- A category's `immune`, `overridable` or `pinnedLast` setting changes
- A complete taxonomy is designed for a new image domain
- The impact of category settings on classification output needs explaining

## Steps

### 1. Gather requirements

- Category name (must be `lowercase_snake_case`)
- Description (1 sentence, used directly in the LLM prompt)
- Is it **immune**? (temporal consensus never overrides it)
- Is it **overridable**? (cluster majority may override it when ambiguous)
- Should it be **pinned last** in the output?

### 2. Validate the category name

The name must match `/^[a-z][a-z0-9_]*$/`: underscores, no hyphens, no capitals, no spaces.
`CategoryConfigSchema` in `packages/core/src/config/index.ts` enforces this at load time.
Examples: `water_damage`, `mold_growth`, `misc`; NOT `water-damage`.

### 3. Apply the categories file

Edit the target `categories.json` (default: `examples/categories.json`):

- Append to `categories` array: `{ "name": "...", "description": "..." }`
- If immune: append to `immune` array
- If overridable: append to `overridable` array
- If pinned: append to `pinnedLast` array (before `unknown` if present)

`CategoryConfigSchema` also rejects: `pinnedLast` / `immune` / `overridable` entries that are
not defined category names or `"unknown"`, an invalid IANA timezone in `timezone`, and a file
with no categories at all.

### 4. Verify no test fixtures need updating

Search `packages/core/tests/` for hardcoded category arrays; if found, add the new category
there too. Ensure all `Config` fixtures include `concurrency: 1` and all `AnalysisResult`
fixtures include `confidence: 0` and `extractedText: null`.

If the new category requires a new field in `AnalysisResult` (rare; avoid unless truly
domain-agnostic), follow [Cache schema migration](#cache-schema-migration) below.

### 5. Check for description overlap

Read all existing category descriptions and compare with the new one. If two descriptions could
apply to the same image, rewrite one to be more specific: each description should be a single
clear sentence, written from the perspective of someone viewing the image, that excludes its
nearest neighbor.

### 6. Confirm and dry-run

Verify the config parses and the category lands:

```bash
pnpm run typecheck && pnpm test

node packages/cli/dist/index.js \
  --input ./sample-photos \
  --output ./out \
  --categories ./examples/categories.json \
  --dry-run --verbose
```

Reminders for the user:

- The LLM prompt is built dynamically from the categories file; no code changes needed
- The new category takes effect on the next run
- If images that should match it are classified elsewhere, revise the description

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

## Setting up a new domain from scratch

When the whole taxonomy is new, not just one category:

1. Design a complete, schema-valid `categories.json` for the domain (for example under
   `examples/<domain>/categories.json`). Per category:
   - Name: `lowercase_snake_case`, max 40 chars, no hyphens or spaces
   - Description: one sentence starting with a visual signal ("Images showing...",
     "Photos where...") concrete enough for an LLM to decide membership
   - `immune`: ground-truth or safety-critical categories (e.g. `severe_damage`,
     `critical_finding`) that consensus must never override
   - `overridable`: categories a burst majority may override (e.g. `unknown`)
   - `pinnedLast`: catch-all or unusable categories
2. Required constraints: every domain has one `pinnedLast` catch-all (`unknown` or equivalent,
   with `overridable` set); total categories ideally 4 to 12; above 12, flag the file with a
   note to consider a two-pass approach.
3. Validate against the Zod schema:

```bash
node --input-type=module --eval "
import { CategoryConfigSchema } from './dist/config/index.js';
import { readFileSync } from 'fs';
const raw = JSON.parse(readFileSync('./examples/<domain>/categories.json', 'utf8'));
const parsed = CategoryConfigSchema.parse(raw);
console.log('VALID:', parsed.categories.length, 'categories');
parsed.categories.forEach(c => console.log(' -', c.name));
"
```

4. Produce the run command for the domain:

```bash
node dist/cli/index.js \
  --input ./<domain>-images \
  --output ./<domain>-output \
  --categories-file ./examples/<domain>/categories.json \
  --provider openai \
  --concurrency 3
```

5. Accuracy expectations: do NOT promise a precision figure. Accuracy is measured, not
   guaranteed; every number depends on the dataset, the model, the prompt and the descriptions
   (ADR-008, `docs/adr/008-evidence-policy.md`). State plainly that first-run accuracy is
   unknown until measured: run the real-data benchmark with `vision-lens benchmark run`
   (artifacts in `benchmarks/results/<runId>/` with the full reproduction tuple), note that the
   VisA-derived gold split (`benchmarks/splits/*.gold.json`, license and checksums in
   `datasets/registry.json`) measures industrial anomaly classes, not the user's domain, and
   never cite the synthetic `benchmark:legacy` harness as an accuracy figure. Recommended
   first step: run with 50 representative images, review with `--interactive`, then tune
   prompts (see [tune-prompt.md](./tune-prompt.md)).

## Cache schema migration

When a change adds or removes a field of `AnalysisCache` or `PartialAnalysisCache`:

1. Increment `CACHE_SCHEMA_VERSION` in `packages/core/src/types.ts` with a comment describing
   the change:

```typescript
// v2: added categoriesHash field.
// v3: added <your field> to <interface>.
export const CACHE_SCHEMA_VERSION = 3; // <- increment
```

2. Update the interface(s) in `packages/core/src/types.ts`. All fields are required
   (non-optional) unless backward compatibility demands otherwise.
3. Update every write site that constructs an `AnalysisCache` or `PartialAnalysisCache` literal
   (search `packages/core/src/index.ts`: the final cache write block and `flushPartialCache`).
   Do not suppress TypeScript errors with `as`; the compiler must catch missing fields.
4. Update every read site: the `--skip-analysis` path (reads `cache.images`), `runReorder` in
   `packages/core/src/index.ts`, and the partial cache resume (a `schemaVersion` mismatch starts
   fresh, which is already handled).
5. Update the migration chain `migrateCache(raw: unknown): AnalysisCache` in
   `packages/core/src/store/migrate.ts` so an old cache upgrades to the new shape on read.
6. Update every test fixture that constructs a mock cache; common locations:
   `packages/core/tests/analyzer/batch.test.ts`, `packages/core/tests/classifier/index.test.ts`
   (search `grep -rn "AnalysisCache\|PartialAnalysisCache" packages/core/tests/`).
7. Verify: `pnpm run typecheck` (zero errors) and `pnpm test` (all pass, coverage above
   thresholds).
8. Update the schema version references in `AGENTS.md` and the `Known limitations` table in
   `ROADMAP.md` if the migration resolves a listed issue.
