---
mode: agent
description: Diagnose and fix a high rate of images classified as "unknown"
---

# Fix high unknown rate

I'm getting too many images classified as `unknown` in Vision Lens.

**Provider:** {{PROVIDER}} (openai / anthropic / google)
**Unknown rate:** {{UNKNOWN_RATE}} (e.g. "40% of images")
**Category config:** {{CATEGORIES_FILE}} (path to categories.json, or "default")
**Sample unknown filenames:** {{SAMPLE_FILES}} (list a few, or "not sure")

Please diagnose and fix in order:

## Step 1 — Check category descriptions

Read the categories in `{{CATEGORIES_FILE}}` (or `examples/categories.json`).
Check each `description` field:
- Is it clear and unambiguous?
- Do any two categories overlap significantly?
- Is it written from the perspective of someone looking at a photo (not an inspector)?

Suggest rewritten descriptions for any that are vague or overlapping.

## Step 2 — Check the batch prompt

Read `src/analyzer/batch.ts` → `buildBatchPrompt()`.
The prompt must:
- List all categories with their descriptions
- Tell the model to use `"unknown"` only when truly undecidable
- Remind the model that burst sequences are almost certainly the same category

If the prompt is missing any of these, show the fix.

## Step 3 — Check the reclassify pass

Read `src/analyzer/index.ts` → `reclassifyUnknowns()`.
Verify:
- It runs after the batch pass (skipped when `config.dryRun === true`)
- It uses `detail: 'high'` for the reclassify call
- It logs `Reclassified:` for each image that changed category

If the reclassify pass is skipped or broken, show the fix.
Note: `--dry-run` intentionally skips reclassification — test without it to see the full pipeline.

## Step 4 — Check temporal consensus

Read `src/analyzer/temporal.ts` → `applyTemporalConsensus()`.
Verify:
- The window (`config.temporalWindowMinutes`, default 5) is appropriate for the input dataset
  (e.g. e-commerce shots taken seconds apart need `--temporal-window 1`)
- The threshold (`config.consensusThreshold`, default 0.6) is not too high for small clusters
- `unknown` is in `config.categoryConfig.overridable` — if not, temporal consensus cannot fix it

Suggest `--temporal-window` and `--consensus-threshold` values if the defaults are wrong.

## Step 5 — Propose a test run

Suggest a minimal reproduction command using:
- `--dry-run` to avoid writing files
- `--verbose` to see per-image classification
- `--batch-size 5` to inspect a small subset
- The fixed `categories.json`

Show the exact command.
