---
mode: insert
description: Set up Vision Lens for a new image domain from scratch
---

You are setting up Vision Lens for a new image domain.

## Domain parameters

Domain name: {{DOMAIN}}
Categories: {{CATEGORY_NAMES}}

## What to produce

### 1. `examples/{{DOMAIN}}/categories.json`

Design a complete, schema-valid `categories.json` for the `{{DOMAIN}}` domain using
the category names in `{{CATEGORY_NAMES}}` as a starting point.

For each category:

- Name: `lowercase_snake_case` (max 40 chars, no hyphens or spaces)
- Description: One sentence starting with a visual signal ("Images showing...", "Photos where...")
  that is concrete enough for an LLM to decide membership. Include visual examples.
- `immune`: `true` if this is ground-truth or safety-critical (should never be overridden by consensus)
- `overridable`: `true` if surrounding images in a burst should be able to override this classification
- `pinnedLast`: `true` if this is a catch-all or "unusable" category

Required constraints:

- Every domain MUST have one `pinnedLast: true` catch-all (e.g. `unknown`, `unusable`, `unclear`)
- `unknown` or equivalent: `pinnedLast: true`, `overridable: true`
- Severity categories (e.g. `severe_damage`, `critical_finding`): `immune: true`
- Total categories: ideally 4–12; flag if > 12 with a note to consider a two-pass approach

The `defaultCategory` should be the catch-all category name.

### 2. `.env.example` additions

List any domain-specific environment variables if the domain requires a different model
or provider than the defaults. Note: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY`
are already documented in the root `.env.example`.

### 3. Run command

Produce a ready-to-paste run command for the `{{DOMAIN}}` domain:

```bash
node dist/cli/index.js \
  --input ./{{DOMAIN}}-images \
  --output ./{{DOMAIN}}-output \
  --categories-file ./examples/{{DOMAIN}}/categories.json \
  --provider openai \
  --concurrency 3
```

### 4. Validation

Validate the produced `categories.json` against the Zod schema:

```bash
node --input-type=module --eval "
import { CategoryConfigSchema } from './dist/config/index.js';
import { readFileSync } from 'fs';
const raw = JSON.parse(readFileSync('./examples/{{DOMAIN}}/categories.json', 'utf8'));
const parsed = CategoryConfigSchema.parse(raw);
console.log('VALID:', parsed.categories.length, 'categories');
parsed.categories.forEach(c => console.log(' -', c.name));
"
```

### 5. Accuracy expectations

Do NOT promise a precision figure. Accuracy is **measured, not guaranteed** — every number
depends on the dataset, the model, the prompt and the category descriptions, so a fixed
percentage is a claim this repo cannot make (ADR-008).

- State plainly that first-run accuracy is unknown until it is measured on representative data
- Point the user at the real-data benchmark: `vision-lens benchmark run`, whose artifacts land in
  `benchmarks/results/<runId>/` (JSON + Markdown) with the full reproduction tuple
  (dataset snapshot, split fingerprint, model version, config fingerprint, env capture)
- Note that the dataset is dataset-dependent: the VisA-derived gold split
  (`benchmarks/splits/*.gold.json`, dataset license and checksums in `datasets/registry.json`)
  measures industrial anomaly classes, NOT the user's domain — treat it as a harness and
  methodology reference, never as a prediction for their categories
- The legacy `benchmark:legacy` script is a SYNTHETIC unit-fixture harness (colour swatches);
  never cite its output as an accuracy figure
- Recommend: run with 50 representative images first, review with `--interactive`, then tune prompts
