---
name: tune-prompt
description: Use when a user reports a high unknown rate, confusion between two specific categories, a switch to a new image domain, or a need to add domain-specific guidance to the batch and reclassify prompts without breaking the JSON response contract.
---

# Skill: Tune LLM Batch Prompt

**Domain:** Optimising `buildBatchPrompt()` and `RECLASSIFY_PROMPT` for a specific image domain

## When to use this skill

Use this skill when a user reports:

- High `unknown` rate with a custom `categories.json`
- The model consistently confuses two specific categories
- They are switching to a new domain (e.g. from property inspection to e-commerce)
- They want to add domain-specific guidance to the LLM prompt without breaking the JSON contract

## Steps

### 1. Read the current prompts

Read `src/analyzer/batch.ts` → `buildBatchPrompt()` and
`src/analyzer/index.ts` → `RECLASSIFY_PROMPT`.

Note the exact JSON response schema the prompts require:

```json
{
  "images": [
    { "index": N, "category": "...", "shortDescription": "...", "fullDescription": "...", "elements": [...], "confidence": 0.9, "extractedText": null }
  ]
}
```

**Never change this schema** without a corresponding change to `parseAnalysisResult()` and `BatchEnvelopeSchema`.
If prompt changes affect the Zod envelope shape, also bump `CACHE_SCHEMA_VERSION` in `src/types.ts` and add
a migration step in `packages/core/src/store/migrate.ts`.

### 2. Diagnose the specific confusion

Ask the user:

- Which categories are being confused? (e.g. `bedroom` vs `living_room`)
- Are the confused images typically ambiguous, or clearly one category?
- Is the confusion consistent across providers, or only one?

### 3. Improve category descriptions first

Before touching the prompt code, update the `description` field in `categories.json`:

- Be explicit about what distinguishes the category from its nearest neighbour
- Use visual discriminators ("has a bed frame visible" vs "has a sofa visible")
- Avoid abstract concepts ("used for sleeping") — use what's visible in the image

### 4. Add per-category examples (if descriptions aren't enough)

Add an `examples` array to the category in `categories.json`:

```json
{ "name": "bedroom", "description": "...", "examples": ["bed frame visible", "wardrobe"] }
```

Update `buildCategoriesBlock()` in `src/analyzer/batch.ts` to include examples in the prompt
output when present. The change must be backward-compatible (examples are optional).

### 5. Add domain-specific context to the batch prompt (last resort)

If categories.json changes aren't enough, add a single paragraph to `buildBatchPrompt()`:

- Placed after the `USE THE FULL SEQUENCE TO YOUR ADVANTAGE` section
- Describe the domain: "These are real-estate inspection photos taken by a field inspector..."
- Keep it under 50 words — longer context degrades the JSON compliance rate

### 6. Test the change

Run with `--dry-run --verbose --batch-size 5` on a small sample:

```bash
node dist/cli/index.js \
  --input ./sample-images \
  --categories ./my-categories.json \
  --provider openai \
  --dry-run \
  --verbose \
  --batch-size 5
```

Compare the classification log to what you expect. Iterate.

### 7. Never break the JSON contract

After any prompt change, run the contract test suite to verify the LLM still returns
a valid `{ images: [...] }` envelope:

```bash
CI_CONTRACT=1 npx vitest run tests/analyzer/client.contract.test.ts
```

If you changed `buildBatchPrompt()` in a way that affects the expected response count,
also update `batch.test.ts` accordingly.

## Success criteria

- Unknown rate drops below 10% on the target dataset
- No regressions in the categories that were already working
- `pnpm test` passes
- Contract tests pass with `CI_CONTRACT=1`
