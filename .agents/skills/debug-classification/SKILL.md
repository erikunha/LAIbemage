---
name: debug-classification
description: Use when a user reports poor LLM classification results in Vision Lens: too many images classified as unknown, images landing in the wrong category, inconsistent results between runs or providers, or temporal consensus overriding correct classifications.
---

# Skill: Debug Classification

**Domain:** Diagnosing poor LLM classification results in Vision Lens

## When to use this skill

Use this skill when a user reports:

- Too many images classified as `unknown`
- Images classified into the wrong category consistently
- Inconsistent results between runs or providers
- Temporal consensus overriding correct classifications

## Steps

### 1. Gather symptoms

Ask the user:

- Which provider are they using? (`openai`, `anthropic`, or `google`)
- What percentage of images are `unknown`?
- Are specific categories wrong, or is it random?
- Did they recently change `categories.json`?
- Are the issues consistent across runs or only sometimes?

### 2. Check the prompt quality

Read `packages/core/src/analyzer/batch.ts` → `buildBatchPrompt()`:

- Are category descriptions clear and non-overlapping?
- Is the JSON schema in the prompt well-defined?
- Are there more than 15 categories? (performance degrades above ~12)

Read `examples/categories.json` (or the user's categories file):

- Are descriptions one clear sentence each?
- Do any descriptions overlap significantly? (e.g. two similar room types)
- Are any descriptions too short or vague?

**Fix:** Improve category descriptions. Each should be a single clear sentence that excludes
similar categories. Example:

```
"description": "Any view from inside a kitchen, including countertops, appliances, and cabinets"
```

### 3. Check the detail level

In `packages/core/src/analyzer/batch.ts`, batch calls use `detail: 'low'` (768px). For fine-grained details
(small text, subtle damage), this may be insufficient.

In `packages/core/src/analyzer/index.ts`, reclassification uses `detail: 'high'` (1024px).

**Fix:** If images require detail to classify (e.g. subtle mold, small print), reduce batch size
and consider using `detail: 'high'` for the first pass (higher cost but better accuracy).

### 4. Check temporal consensus settings

Read `packages/core/src/analyzer/temporal.ts`:

- Cluster window: 5 minutes — too short? (photos taken over hours will not cluster)
- Override threshold: 60% — too aggressive?
- Is the correct category `immune`? (immune categories are never overridden)

Check `examples/categories.json`:

- Is the problematic category in `immune`? It should be if it should never be overridden.
- Is it in `overridable`? It should be if it's OK to override by consensus.

**Fix options:**

- Add the category to `immune` if temporal consensus is wrongly overriding it
- Widen the cluster window if photos are spread over a longer time period
- Raise the override threshold in `temporal.ts` if consensus is too aggressive

### 5. Check provider-specific JSON parsing

In `packages/core/src/analyzer/client.ts`, Google Gemini responses may include markdown fences
(` ```json ``` `). The `extractJson()` helper strips these.

**Fix:** If using Google, confirm `extractJson()` is stripping the fences correctly:

````typescript
// In client.ts — extractJson() should handle:
// ```json\n{...}\n```  →  {...}
````

For Anthropic, confirm the SDK returns clean JSON text without additional wrapping.

### 6. Run a targeted single-image test

Use the `single` subcommand to isolate a specific problematic image:

```bash
npx @vision-lens/cli single 42 ./input/problematic-image.jpg \
  --provider openai \
  --categories ./examples/categories.json \
  --verbose
```

The `--verbose` flag logs the raw LLM response. Check:

- Is the response valid JSON?
- Does the LLM explain its reasoning in the response?
- Is the chosen category plausible given the image?

### 7. Cross-provider comparison

Run the same image batch with different providers to identify if the issue is
provider-specific or prompt/category-specific:

```bash
npx @vision-lens/cli --provider openai --output output-openai/
npx @vision-lens/cli --provider anthropic --output output-anthropic/
npx @vision-lens/cli --provider google --output output-google/
```

Compare `output-*/analysis_results.json` for divergent classifications.

### 8. Review the reclassification pass

The second pass (reclassification) targets `unknown` images with `detail: 'high'`.
Read `RECLASSIFY_PROMPT` in `packages/core/src/analyzer/index.ts`.

**Fix:** Add more discriminating language to `RECLASSIFY_PROMPT` for the categories that are
being misclassified. Use the single-image test (step 6) to verify improvements.

## Diagnostic checklist summary

| Check                             | File                                     | Common fix            |
| --------------------------------- | ---------------------------------------- | --------------------- |
| Category descriptions vague       | `examples/categories.json`               | Rewrite descriptions  |
| Overlapping categories            | `examples/categories.json`               | Merge or clarify      |
| Batch prompt too generic          | `packages/core/src/analyzer/batch.ts`    | Add exclusion hints   |
| Temporal consensus too aggressive | `packages/core/src/analyzer/temporal.ts` | Add to `immune`       |
| JSON parse errors (Google)        | `packages/core/src/analyzer/client.ts`   | Check `extractJson()` |
| Reclassify prompt weak            | `packages/core/src/analyzer/index.ts`    | Strengthen prompt     |
