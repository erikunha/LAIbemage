# Debug classification

Covers diagnosing poor LLM classification results: too many `unknown` images, wrong categories,
inconsistent results between runs or providers, and temporal consensus overriding correct
labels. It also carries the focused high-unknown-rate checklist and the security review of the
untrusted LLM-output path, both folded in from former command guides. Use it whenever
classification quality is wrong and the cause is unknown.

## When to use

- Too many images classified as `unknown`
- Images consistently classified into the wrong category
- Inconsistent results between runs or providers
- Temporal consensus overriding correct classifications
- A security review of how untrusted LLM output reaches the filesystem and reports (see
  [Security review of the untrusted-data path](#security-review-of-the-untrusted-data-path))

## Steps

### 1. Gather symptoms

- Which provider is in use? (`openai`, `anthropic`, `google`)
- What percentage of images are `unknown`?
- Are specific categories wrong, or is it random?
- Was `categories.json` changed recently?
- Are the issues consistent across runs or only sometimes?

### 2. Check the prompt quality

Read `packages/core/src/analyzer/batch.ts` `buildBatchPrompt()`:

- Are category descriptions clear and non-overlapping?
- Is the JSON schema in the prompt well-defined?
- Are there more than 15 categories? (performance degrades above ~12)

Read `examples/categories.json` (or the active categories file):

- Is each description one clear sentence, written from the perspective of someone looking at a
  photo?
- Do any descriptions overlap significantly? (e.g. two similar room types)
- Are any descriptions too short or vague?

**Fix:** rewrite descriptions. Each should be a single clear sentence that excludes similar
categories, e.g.
`"description": "Any view from inside a kitchen, including countertops, appliances, and cabinets"`.
The prompt must also list every category with its description, tell the model to use `"unknown"`
only when truly undecidable, and note that burst sequences are almost certainly the same
category.

### 3. Check the detail level

In `packages/core/src/analyzer/batch.ts`, batch calls use `detail: 'low'` (768px). For
fine-grained details (small text, subtle damage) this may be insufficient. In
`packages/core/src/analyzer/index.ts`, reclassification uses `detail: 'high'` (1024px).

**Fix:** if images need detail to classify (e.g. subtle mold, small print), reduce batch size
and consider `detail: 'high'` for the first pass (higher cost, better accuracy).

### 4. Check the reclassify pass

Read `reclassifyUnknowns()` in `packages/core/src/analyzer/index.ts`. Verify:

- It runs after the batch pass (skipped only when `config.dryRun === true`; test without
  `--dry-run` to see the full pipeline)
- It uses `detail: 'high'` for the reclassify call
- It logs `Reclassified:` for each image that changed category

It is separate from the optional `--self-critique` fourth pass in
`packages/core/src/analyzer/critique.ts`. If reclassification misses categories that are being
misclassified, add more discriminating language to `RECLASSIFY_PROMPT` (see
[tune-prompt.md](./tune-prompt.md)).

### 5. Check temporal consensus

Read `applyTemporalConsensus()` in `packages/core/src/analyzer/temporal.ts`:

- Cluster window `config.temporalWindowMinutes` (default 5): photos taken over hours will not
  cluster; e-commerce shots seconds apart may need `--temporal-window 1`
- Override threshold `config.consensusThreshold` (default 0.6): may be too aggressive for small
  clusters
- `"unknown"` must be listed in `config.categoryConfig.overridable`, or consensus cannot fix it

**Fix options:**

- Add the category to `immune` if temporal consensus is wrongly overriding it
- Widen the cluster window if photos are spread over a longer period
- Raise the override threshold in `temporal.ts` if consensus is too aggressive

### 6. Check provider-specific JSON parsing

In `packages/core/src/analyzer/client.ts`, Google Gemini responses may include markdown fences
(``` ```json ``` ```). The `extractJson()` helper strips them; confirm it still handles
` ```json\n{...}\n``` ` correctly. For Anthropic, confirm the SDK returns clean JSON text
without additional wrapping.

### 7. Run a targeted single-image test

Use the `single` subcommand to isolate a problematic image:

```bash
npx @vision-lens/cli single 42 ./input/problematic-image.jpg \
  --provider openai \
  --categories ./examples/categories.json \
  --verbose
```

The `--verbose` flag logs the raw LLM response. Check: is the response valid JSON, does the LLM
explain its reasoning, is the chosen category plausible given the image?

### 8. Cross-provider comparison

Run the same image batch with different providers to identify whether the issue is
provider-specific or prompt/category-specific:

```bash
npx @vision-lens/cli --provider openai --output output-openai/
npx @vision-lens/cli --provider anthropic --output output-anthropic/
npx @vision-lens/cli --provider google --output output-google/
```

Compare `output-*/analysis_results.json` for divergent classifications, or diff two result
files directly with `vision-lens diff` (see [tune-prompt.md](./tune-prompt.md#7-compare-runs-with-vision-lens-diff)).

### 9. Propose the verification run

End every diagnosis with an exact command using `--dry-run` (no file writes), `--verbose`
(per-image classification), `--batch-size 5` (small subset) and the fixed categories file:

```bash
node packages/cli/dist/index.js \
  --input ./photos \
  --output ./out \
  --categories ./categories.json \
  --provider openai \
  --dry-run --verbose --batch-size 5
```

## Diagnostic checklist summary

| Check                             | File                                     | Common fix            |
| --------------------------------- | ---------------------------------------- | --------------------- |
| Category descriptions vague       | `examples/categories.json`               | Rewrite descriptions  |
| Overlapping categories            | `examples/categories.json`               | Merge or clarify      |
| Batch prompt too generic          | `packages/core/src/analyzer/batch.ts`    | Add exclusion hints   |
| Reclassify pass weak or skipped   | `packages/core/src/analyzer/index.ts`    | Strengthen `RECLASSIFY_PROMPT`, drop `--dry-run` |
| Temporal consensus too aggressive | `packages/core/src/analyzer/temporal.ts` | Add to `immune`       |
| JSON parse errors (Google)        | `packages/core/src/analyzer/client.ts`   | Check `extractJson()` |

## Security review of the untrusted-data path

Vision Lens processes untrusted LLM text responses and writes them to the filesystem. The
primary attack surfaces: the `category` field used in output filenames, path traversal via
`--categories`, prompt injection in cached data rendered into HTML or logs, and XSS in the HTML
report. Audit in this order:

**CRITICAL**

- `packages/core/src/processor/exporter.ts`: `category` is sanitized before interpolation into
  a filename (strip `/`, `\`, null bytes; cap at 100 chars)
- `packages/core/src/analyzer/batch.ts`: the parsed `category` is validated against the known
  category list; a raw LLM string never reaches the filesystem without an allowlist check
- `packages/core/src/config/index.ts`: the `--categories` path is resolved with `path.resolve()`
  and optionally checked against a trusted base

**HIGH**

- `packages/core/src/analyzer/batch.ts` uses `BatchEnvelopeSchema.safeParse()` (not a bare
  `JSON.parse as`), and `packages/core/src/analyzer/index.ts` uses
  `ReclassifyResponseSchema.safeParse()`
- HTML output escapes `shortDescription`, `fullDescription`, `elements` (see the reporter
  checklist in `STANDARDS.md`)
- The `--skip-analysis` path in `packages/core/src/index.ts` validates
  `cache.images[].originalFile` before `path.join(config.inputDir, r.originalFile)`: a crafted
  cache with `"../../../etc/passwd"` escapes `inputDir` unless the value is a bare filename

**MEDIUM**

- `packages/core/src/utils/logger.ts` truncates LLM data interpolated into log messages
- `.env` and `.env.*` (except `.env.example`) are git-ignored

**LOW**

- `packages/cli/src/index.ts` parses numeric flags with `parseInt`/`parseFloat`, never coercion
- `--output` is prevented from pointing at `--input` (would overwrite originals)

Report findings as CRITICAL (fix before any production use), HIGH (fix before next release),
MEDIUM (next sprint), LOW (backlog), each with `file:line`, description and fix.
