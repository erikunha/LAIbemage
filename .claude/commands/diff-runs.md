# Diff Two Runs

Compare two `analysis_results.json` files to see what changed between runs.

**Usage:** $ARGUMENTS (e.g. "output/before.json output/after.json")

## When to use

- After re-running with a different model or provider: verify which images changed categories
- After editing `categories.json` and re-running: confirm the taxonomy change had the expected effect
- After `--learn`: verify few-shot injection actually improved uncertain images
- After `--self-critique`: verify which images were reclassified

## Command

```bash
# Compare two saved results files
vision-lens diff ./output/before.json ./output/after.json

# JSON output for scripting
vision-lens diff ./output/before.json ./output/after.json --output-format json

# Save a snapshot before a risky change
cp ./output/analysis_results.json ./output/analysis_results_backup.json
vision-lens --input ./photos --output ./output --skip-analysis  # re-run with new categories
vision-lens diff ./output/analysis_results_backup.json ./output/analysis_results.json
```

## Output

The diff shows:
- **Added images**: present in `after` but not `before` (new files processed)
- **Removed images**: present in `before` but not `after` (files removed or filtered)
- **Category changed**: same file, different category (`kitchen` → `bathroom`)
- **Confidence changed**: same category, meaningfully different confidence score

## Reading the change summary

```
Summary: 3 added, 0 removed, 12 category_changed, 5 confidence_changed
```

High `category_changed` count after adding a new category = expected (images found a better home).
High `category_changed` count after a model upgrade = review the changes; some may be regressions.

## Implementation details

`diffCaches()` is exported from `packages/sdk/src/index.ts` (`@vision-lens/sdk`). It is a pure function — no I/O, fully testable.
The CLI writes the result to stdout. JSON mode emits `{ summary, changes[] }` for scripting.
