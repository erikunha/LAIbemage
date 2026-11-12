# Tune the LLM prompts

Covers tuning `buildBatchPrompt()` and the reclassify prompt for a specific image domain without
breaking the JSON response contract, and comparing runs before and after a change with
`vision-lens diff` (the comparison recipe folded in from the former diff-runs command guide).
Use it when the `unknown` rate is high, two categories confuse each other, the tool is being
switched to a new domain, or domain-specific guidance must reach the prompt.

## When to use

- High `unknown` rate with a custom `categories.json`
- The model consistently confuses two specific categories
- A switch to a new domain (e.g. from property inspection to e-commerce)
- Domain-specific guidance must be added without breaking the JSON contract

## The four LLM passes

Know which pass is failing before editing it:

| Pass | Where | What it does |
| ---- | ----- | ------------ |
| Batch classification | `packages/core/src/analyzer/batch.ts` `buildBatchPrompt()` | Initial classification of all images |
| Reclassification | `packages/core/src/analyzer/index.ts` `RECLASSIFY_PROMPT` via `reclassifyUnknowns()` | Automatic third pass over `unknown` and low-confidence images; runs after the batch pass unless `config.dryRun === true` |
| Self-critique | `packages/core/src/analyzer/critique.ts` `runSelfCritique()` | Optional fourth pass (`--self-critique`); flags images inconsistent with their neighbors |

## Steps

### 1. Read the current prompts and the contract

Read `packages/core/src/analyzer/batch.ts` `buildBatchPrompt()` and
`packages/core/src/analyzer/index.ts` `RECLASSIFY_PROMPT`. Note the exact JSON response schema
the prompts require:

```json
{
  "images": [
    { "index": N, "category": "...", "shortDescription": "...", "fullDescription": "...", "elements": [...], "confidence": 0.9, "extractedText": null }
  ]
}
```

**Never change this schema** without a corresponding change to `parseAnalysisResult()` and
`BatchEnvelopeSchema`. If prompt changes affect the Zod envelope shape, bump
`CACHE_SCHEMA_VERSION` in `packages/core/src/types.ts` and add a migration step in
`packages/core/src/store/migrate.ts` (full checklist in
[add-category.md](./add-category.md#cache-schema-migration)).

### 2. Diagnose the failure

Common patterns:

| Symptom | Root cause |
| ------- | ---------- |
| Many `unknown` results | Categories not described clearly enough, or the model is not told to minimize `unknown` |
| Burst sequences split across categories | No instruction to treat consecutive similar photos as one category; also consider `--dedupe-threshold` to skip near-identical frames before analysis |
| Wrong category for edge-case images | Two category descriptions overlap; rewrite them to be mutually exclusive |
| Reclassify not helping | `detail: 'high'` not set, or reclassify skipped by `--dry-run` |

Ask which categories are confused, whether the confused images are genuinely ambiguous, and
whether the confusion is consistent across providers or only one.

### 3. Improve category descriptions first

Before touching prompt code, update the `description` field in `categories.json`:

- Be explicit about what distinguishes the category from its nearest neighbor
- Use visual discriminators ("has a bed frame visible" vs "has a sofa visible")
- Avoid abstract concepts ("used for sleeping"); describe what is visible in the image

### 4. Add per-category examples (if descriptions are not enough)

Add an `examples` array to the category in `categories.json`:

```json
{ "name": "bedroom", "description": "...", "examples": ["bed frame visible", "wardrobe"] }
```

Update `buildCategoriesBlock()` in `packages/core/src/analyzer/batch.ts` to include examples in
the prompt output when present. The change must be backward-compatible (examples are optional).

### 5. Add domain context to the batch prompt (last resort)

If `categories.json` changes are not enough, add a single paragraph to `buildBatchPrompt()`:

- Placed after the `USE THE FULL SEQUENCE TO YOUR ADVANTAGE` section
- Describe the domain: "These are real-estate inspection photos taken by a field inspector..."
- Keep it under 50 words; longer context degrades the JSON compliance rate

Make the smallest change that addresses the root cause (one clarifying sentence, one explicit
instruction, a stronger "use unknown only as last resort"). Do not rewrite the whole prompt;
test the minimal delta first.

### 6. Test the change on a minimal reproduction

Run with `--dry-run --verbose --batch-size 5` on a sample of the problematic images and capture
the per-image output:

```bash
node dist/cli/index.js \
  --input ./sample-images \
  --categories ./my-categories.json \
  --provider openai \
  --dry-run \
  --verbose \
  --batch-size 5
```

Iterate until the classification log matches expectations.

### 7. Compare runs with `vision-lens diff`

Snapshot before a risky change, then diff:

```bash
# Save a snapshot before the change
cp ./output/analysis_results.json ./output/analysis_results_backup.json
vision-lens --input ./photos --output ./output --skip-analysis   # re-run with new categories
vision-lens diff ./output/analysis_results_backup.json ./output/analysis_results.json

# JSON output for scripting
vision-lens diff ./output/before.json ./output/after.json --output-format json
```

The diff reports **added images** (in `after` only), **removed images** (in `before` only),
**category changed** (same file, different category) and **confidence changed**, with a summary
line such as `Summary: 3 added, 0 removed, 12 category_changed, 5 confidence_changed`.
A high `category_changed` count after adding a category is expected (images found a better
home); after a model upgrade it deserves review, since some changes may be regressions. The same
comparison verifies the effect of `--learn` and `--self-critique` runs. `diffCaches()` is
exported from `packages/sdk/src/index.ts` (`@vision-lens/sdk`); it is a pure function, no I/O.

### 8. Never break the JSON contract

After any prompt change, run the contract test suite to verify the LLM still returns a valid
`{ images: [...] }` envelope:

```bash
CI_CONTRACT=1 pnpm exec vitest run packages/core/tests/analyzer/client.contract.test.ts
```

If the change affects the expected response count, update
`packages/core/tests/analyzer/batch.test.ts` accordingly (especially the prompt content
assertions).

### 9. Document the why

Add a comment to `buildBatchPrompt()` or the reclassify prompt explaining why a non-obvious
instruction exists (e.g. "burst sequence hint reduces unknown rate by ~15% on real-estate
datasets").

## Success criteria

- Unknown rate drops below 10% on the target dataset
- No regressions in the categories that were already working
- `pnpm test` passes
- Contract tests pass with `CI_CONTRACT=1`
