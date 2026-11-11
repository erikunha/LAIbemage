# Fix High Unknown Rate

Diagnose and fix a high rate of images classified as `unknown`.

**Context:** $ARGUMENTS (e.g. "40% unknown, provider=openai, categories=examples/categories.json")

## Step 1 — Check category descriptions

Read the active `categories.json`. For each category, check:
- Is the `description` clear and written from the perspective of someone viewing a photo?
- Do any two categories overlap significantly?
- Is `"unknown"` listed in `overridable`? (Required for temporal consensus to fix it)

Suggest rewritten descriptions for vague or overlapping ones.

## Step 2 — Check the batch prompt

Read `packages/core/src/analyzer/batch.ts` → `buildBatchPrompt()`. The prompt must:
- List all categories with their descriptions
- Instruct the model to use `"unknown"` only when truly undecidable
- Note that burst sequences are almost certainly the same category

Show any missing elements and the fix.

## Step 3 — Check the reclassify pass

Read `packages/core/src/analyzer/index.ts` → `reclassifyUnknowns()`. Verify:
- It runs after the batch pass (only skipped when `config.dryRun === true`)
- It uses `detail: 'high'` for the reclassify call
- It logs `Reclassified:` for each image that changed

If the reclassify pass is missing or broken, show the fix.

Note: This is the automatic third pass. It is separate from the optional `--self-critique` fourth pass in `packages/core/src/analyzer/critique.ts`.

## Step 4 — Check temporal consensus

Read `packages/core/src/analyzer/temporal.ts` → `applyTemporalConsensus()`. Verify:
- Window (`config.temporalWindowMinutes`, default 5) is appropriate for the dataset
  (e.g. e-commerce shots seconds apart may need `--temporal-window 1`)
- Threshold (`config.consensusThreshold`, default 0.6) isn't too high for small clusters
- `"unknown"` is in `config.categoryConfig.overridable`

Suggest `--temporal-window` and `--consensus-threshold` values if defaults are wrong.

## Step 5 — Propose a test run

Produce an exact command using:
- `--dry-run` (no file writes)
- `--verbose` (per-image classification output)
- `--batch-size 5` (small subset)
- The fixed categories file

Example:
```bash
node packages/cli/dist/index.js \
  --input ./photos \
  --output ./out \
  --categories ./categories.json \
  --provider openai \
  --dry-run --verbose --batch-size 5
```
