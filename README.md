# Vision Lens

AI-powered image classification, timestamp overlay, and sequential organization — runs entirely from the terminal.

[![CI](https://github.com/erikunha/LAIbemage/actions/workflows/ci.yml/badge.svg)](https://github.com/erikunha/LAIbemage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Vision Lens evolution in progress** — this CLI is growing into a Visual Intelligence
> Engineering Workbench (repo stays `erikunha/LAIbemage`): real-dataset benchmarks, visual
> embeddings and search, model training/evaluation with calibration, a Studio review UI, HTTP API
> and an MCP server (ADR-005). The legacy `ai-image-labeling` CLI keeps working unchanged
> throughout. See `docs/architecture/vision-lens.md`, `docs/architecture/baseline-audit.md` and
> `ROADMAP.md`; work lands on the `feat/visual-lens` branch.
>
> **Binary names:** `vision-lens` is the canonical bin (`pnpm add -g @vision-lens/cli` → `vision-lens`).
> The legacy `ai-image-labeling` bin is kept inside the CLI package as a compatibility alias that
> points at `vision-lens` — it prints one stderr deprecation line per run, silenced with
> `VISION_LENS_NO_DEPRECATION=1`. See CHANGELOG.md.
>
> **npm packages:** the new identity publishes from the `@vision-lens` scope (`@vision-lens/cli`,
> `@vision-lens/sdk`, …). Those workspace packages are **not published yet** — until they are,
> install from a clone (see [Development](#development)). The `ai-image-labeling` bin is kept inside
> the CLI package as a deprecated alias that points at `vision-lens`.
>
> **Decisions:** the architecture decision records live in [`docs/adr/`](docs/adr/) (ADR-005+ cover
> the Vision Lens evolution).

---

## What it does

Given a folder of unorganized images, `vision-lens`:

1. Reads EXIF timestamps concurrently from every file
2. Deduplicates burst frames with perceptual hashing (dHash, Hamming distance)
3. Classifies each image via an LLM Vision API using a configurable category taxonomy
4. Applies temporal consensus — images taken within 5 minutes of each other vote on ambiguous classifications
5. Reconstructs shooting sessions at timestamp gaps (if `--session-gap` is set)
6. Runs an optional self-critique pass to reclassify low-confidence results
7. Optionally runs a cross-image linking pass to identify related image pairs
8. Stamps a red timestamp (DD/MM/YYYY HH:MM) in the bottom-center of each photo
9. Renames and exports as `NNN. Photo of <category> dated DD-MM-YYYY.jpeg`
10. Writes `analysis_results.json` atomically so re-runs with `--skip-analysis` are free
11. Generates HTML / CSV / XLSX / SQLite reports on request
12. POSTs results to a webhook and/or uploads to cloud storage if configured

What it does **not** do:

- Face recognition or biometric identification
- Video files — JPEG, PNG, WebP, and TIFF only
- Training or fine-tuning models — it uses hosted Vision APIs as-is
- Guarantee classification accuracy — accuracy is **measured, not guaranteed**. Results depend
  on the LLM provider, the model, your `categories.json` descriptions and the dataset, so no
  fixed percentage is promised here. Real accuracy numbers come from the benchmark artifacts
  under `benchmarks/results/<runId>/` (real-data VisA ground truth, CC BY 4.0 — dataset
  license, source and checksums are recorded in `datasets/registry.json`).
  **Status: the real dataset has not been downloaded yet and no product accuracy number exists**
  — the whole pipeline is proven against a synthetic 30-image fixture, and the first real number
  appears only after the VisA fetch is authorised. The `benchmark:legacy` script is a
  **synthetic** unit-fixture harness over colour swatches; it is a plumbing regression check, not
  an accuracy source (see [ADR-008](docs/adr/008-evidence-policy.md)).

---

## Quick start

The `@vision-lens/*` packages are **not on npm yet**, so install from a clone:

```bash
git clone https://github.com/erikunha/LAIbemage
cd LAIbemage
git checkout feat/visual-lens   # the monorepo layout lives on this branch, not on main
pnpm install
pnpm run build

# Copy the environment template
cp .env.example .env
# Edit .env — set OPENAI_API_KEY (or the key for your chosen provider)

# Run (from the repo root)
node packages/cli/dist/index.js --categories examples/categories.json --input ./my-photos --output ./sorted
```

`--categories` is explicit because the built-in default taxonomy path is not resolvable from a
monorepo checkout — a known bug, tracked separately.

Once the packages are published, the global install becomes:

```bash
# Install globally
pnpm add -g @vision-lens/cli

# Run
vision-lens --input ./my-photos --output ./sorted
```

And, once published, the same without installing:

```bash
pnpm dlx @vision-lens/cli --input ./my-photos --output ./sorted
```

Both forms need the `@vision-lens/*` packages on the npm registry first — until then, install from
a clone as shown above.

### Provider-specific quick starts

```bash
# OpenAI (default)
vision-lens --api-key sk-...

# Anthropic Claude
vision-lens --provider anthropic --anthropic-api-key sk-ant-...

# Google Gemini
vision-lens --provider google --google-api-key AIza...

# Hybrid: run Ollama locally, escalate low-confidence images to OpenAI
vision-lens --provider hybrid \
  --local-model llava \
  --cloud-provider openai --api-key sk-... \
  --local-confidence-threshold 0.70

# AWS Bedrock
vision-lens --provider bedrock \
  --bedrock-region us-east-1 \
  --bedrock-access-key-id AKIA... \
  --bedrock-secret-access-key ...

# Google Vertex AI
vision-lens --provider vertex \
  --vertex-project my-gcp-project \
  --vertex-location us-central1
```

Ollama and Azure accept their endpoint flags only on the `single` and `suggest-categories`
subcommands, so use those when you need a custom URL or endpoint:

```bash
# Ollama (local, no API key required)
vision-lens single 1 ./photo.jpg --provider ollama --ollama-url http://localhost:11434

# Azure OpenAI
vision-lens single 1 ./photo.jpg --provider azure \
  --azure-endpoint https://my-resource.openai.azure.com \
  --azure-api-key <key>
```

---

## Provider feature matrix

| Provider | Async batch | Embeddings | Notes |
|---|---|---|---|
| `openai` | Yes | `text-embedding-3-small` | Default provider |
| `anthropic` | Yes | Falls back to OpenAI embeddings if `OPENAI_API_KEY` is set | |
| `google` | No | `text-embedding-004` | |
| `azure` | Yes | `text-embedding-3-small` via Azure endpoint | Requires an Azure endpoint (`AZURE_OPENAI_ENDPOINT`; `--azure-endpoint` on `single` / `suggest-categories`) |
| `ollama` | No | `nomic-embed-text` | Runs fully locally |
| `bedrock` | No | Falls back to OpenAI embeddings if key is set | AWS credentials required |
| `vertex` | No | `text-embedding-004` | GCP project required |
| `hybrid` | N/A — delegates to cloud tier | Uses cloud provider's embedding backend | Local-first with cloud escalation |

Async batch (`--async` / `--resume`) reduces API cost by ~50% for supported providers. See [Async batch workflow](#async-batch-workflow).

---

## Subcommands

```
vision-lens [OPTIONS]                           # main classification run
vision-lens reorder                             # re-number output after manual edits
vision-lens single <number> <file>              # process one image with a custom sequence number
vision-lens report                              # generate report from existing analysis_results.json
vision-lens suggest-categories                  # sample N images and propose a categories.json taxonomy
vision-lens search --query <text>               # search classified images by semantic query or keyword
vision-lens diff <before.json> <after.json>     # compare two analysis_results.json files
vision-lens import-run <analysis_results.json>  # import a legacy run into the Vision Lens store
vision-lens benchmark run|gate|report           # score a suite, gate it against a baseline, report an artifact
```

---

## CLI reference

### Core

| Flag | Argument | Description | Default |
|---|---|---|---|
| `-i, --input` | `<dir>` | Input directory with source images | `./input` |
| `-o, --output` | `<dir>` | Output directory for processed files | `./output` |
| `--categories` | `<file>` | Path to custom categories.json | `examples/categories.json` (pass it explicitly — see [Quick start](#quick-start)) |
| `--dry-run` | | Analyze without writing output files | `false` |
| `--skip-analysis` | | Skip LLM analysis, use cached `analysis_results.json` | `false` |
| `--force-skip-analysis` | | Skip analysis even if `categories.json` changed since last run | `false` |
| `--estimate` | | Print cost estimate for all providers and exit | `false` |

### Providers

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--provider` | `<name>` | LLM provider: `openai` \| `anthropic` \| `google` \| `azure` \| `ollama` \| `bedrock` \| `vertex` \| `hybrid` | `openai` |
| `--api-key` | `<key>` | OpenAI API key (overrides `OPENAI_API_KEY`) | — |
| `--anthropic-api-key` | `<key>` | Anthropic API key (overrides `ANTHROPIC_API_KEY`) | — |
| `--google-api-key` | `<key>` | Google AI API key (overrides `GOOGLE_API_KEY`) | — |
| `--azure-endpoint` | `<url>` | Azure OpenAI endpoint URL — `single` / `suggest-categories` only | — |
| `--azure-api-key` | `<key>` | Azure OpenAI API key — `single` / `suggest-categories` only | — |
| `--ollama-url` | `<url>` | Ollama server URL — `single` / `suggest-categories` only | `http://localhost:11434` |
| `--bedrock-region` | `<region>` | AWS region for Bedrock | `us-east-1` |
| `--bedrock-access-key-id` | `<key>` | AWS access key ID for Bedrock | — |
| `--bedrock-secret-access-key` | `<key>` | AWS secret access key for Bedrock | — |
| `--vertex-project` | `<id>` | Google Cloud project ID for Vertex AI | — |
| `--vertex-location` | `<location>` | Vertex AI region | `us-central1` |
| `--model` | `<model>` | Model name (defaults: `gpt-4o` / `claude-opus-4-7` / `gemini-2.0-flash`) | — |

`--azure-endpoint`, `--azure-api-key` and `--ollama-url` are **not** accepted by the root
`vision-lens` command — they exist only on the `single` and `suggest-categories` subcommands. On a
full run, configure Azure and Ollama through the `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` and
`OLLAMA_URL` environment variables instead.

### Hybrid routing

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--local-model` | `<model>` | Ollama model for tier-1 local pass in hybrid mode | `llava` |
| `--cloud-provider` | `<name>` | Cloud provider for tier-2 escalation: `openai` \| `anthropic` \| `google` | `openai` |
| `--local-confidence-threshold` | `<n>` | Confidence below which hybrid escalates to cloud (0–1) | `0.70` |
| `--consensus-providers` | `<p1,p2>` | Run two providers in parallel and pick the higher-confidence result | — |

### Async batch

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--async` | | Submit images to provider's Batch API and exit | `false` |
| `--resume` | | Poll `analysis_job.json` until complete, then process normally | `false` |

### Analysis tuning

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--batch-size` | `<n>` | Images per API call | `20` |
| `--max-retries` | `<n>` | Max retries on transient API errors | `3` |
| `--concurrency` | `<n>` | Concurrent API batch calls in-flight | `3` |
| `--temporal-window` | `<minutes>` | Cluster window for temporal consensus voting | `5` |
| `--consensus-threshold` | `<n>` | Majority ratio required for temporal override (0.5–1.0) | `0.6` |
| `--dedupe-threshold` | `<n>` | Hamming distance threshold for burst dedup — burst dedup is ON by default at Hamming distance ≤ 8; `0` turns it off (max 64) | `8` |
| `--session-gap` | `<minutes>` | Split images into sessions at timestamp gaps larger than N minutes | — |
| `--self-critique` | | Run a second LLM pass to reclassify suspicious results | `false` |
| `--link` | | Run cross-image linking pass to identify related pairs | `false` |
| `--link-window` | `<days>` | Time window for grouping images in the linking pass | `7` |
| `--learn` | | Inject override patterns from previous runs into the batch prompt as few-shot examples | `false` |
| `--active-learn` | | Write `active_learning_queue.json` listing images with confidence < 0.5 or unknown category | `false` |

### Embeddings and search

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--embed` | | Generate text embeddings after analysis and write `analysis_embeddings.index.json` | `false` |

### Output

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--output-format` | `<fmt>` | Output format: `pretty` \| `json` \| `none` \| `csv` \| `xlsx` \| `sqlite` | `pretty` |
| `--filename-template` | `<pattern>` | Output filename template — see [Filename template tokens](#filename-template-tokens) | `{n}. Photo of {category} dated {date}` |
| `--output-bucket` | `<uri>` | Upload output to cloud storage: `s3://bucket/prefix`, `gs://bucket/prefix`, `azblob://container/prefix` | — |

### Integrations

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--webhook` | `<url>` | POST `analysis_results.json` to this URL after each run | — |
| `--plugin` | `<path>` | Path to a `.mjs` plugin file (repeatable) | — |

### Logging and diagnostics

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--log-format` | `<fmt>` | Log format: `pretty` \| `json` | `pretty` |
| `--timing` | | Print per-step wall-time breakdown in run summary | `false` |
| `-v, --verbose` | | Show detailed debug logs | `false` |
| `-q, --quiet` | | Suppress all non-error output | `false` |

### Watch mode

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--watch` | | Watch input directory and process new images automatically | `false` |
| `--watch-poll` | | Use polling for watch mode (required on NFS/SMB mounts) | `false` |

### Review

| Flag | Argument | Description | Default |
|---|---|---|---|
| `--interactive` | | Review and override LLM classifications before processing (requires TTY) | `false` |

---

## Filename template tokens

The `--filename-template` flag accepts a pattern string. All tokens are replaced per image:

| Token | Description | Example output |
|---|---|---|
| `{n}` | 3-digit padded sequence number | `001`, `042` |
| `{n:4}` | N-digit padded sequence number | `0001`, `0042` |
| `{category}` | Normalized category name | `kitchen` |
| `{description}` | Short description from the LLM, slugified | `clean-kitchen-with-modern-appliances` |
| `{date}` | Date as DD-MM-YYYY | `09-05-2026` |
| `{date:FORMAT}` | Custom date format using tokens: `YYYY` `YY` `MM` `DD` `M` `D` | `2026-05-09` |
| `{datetime}` | Date and time as DD-MM-YYYY_HH-MM | `09-05-2026_14-30` |
| `{datetime:FORMAT}` | Custom datetime format using tokens: `YYYY` `YY` `MM` `DD` `HH` `mm` `ss` `M` `D` `H` `m` `s` | `2026-05-09T14-30-00` |

The `.jpeg` extension is always appended — there is no `{ext}` token.

Default template: `{n}. Photo of {category} dated {date}`

Example with custom template:

```bash
vision-lens --filename-template '{n:4}_{category}_{date:YYYY-MM-DD}'
# → 0001_kitchen_2026-05-09.jpeg
```

---

## Custom categories

`vision-lens` is domain-agnostic — the classification taxonomy is entirely driven by `categories.json`. A starter config lives in `examples/categories.json`; pass it explicitly with `--categories` (see [Quick start](#quick-start)).

```bash
cp examples/categories-ecommerce.json my-categories.json
vision-lens --categories my-categories.json
```

Schema:

```json
{
  "description": "My taxonomy",
  "categories": [
    { "name": "front_view", "description": "Front-facing product shot on white background" }
  ],
  "pinnedLast": ["unknown"],
  "immune": [],
  "overridable": ["unknown"],
  "timezone": "Europe/London"
}
```

| Field | Description |
|---|---|
| `categories` | Array of `{ name, description }` — descriptions are injected into the LLM prompt verbatim |
| `pinnedLast` | Categories sorted to the end of output, in the order listed |
| `immune` | Never overridden by temporal consensus (use for inherently unambiguous categories) |
| `overridable` | Can be overridden by a cluster majority vote (use for `unknown` and low-confidence categories) |
| `timezone` | IANA timezone for timestamp overlay (default: `UTC`) |

Category names must be `lowercase_snake_case`. Zod validates the schema at startup; an invalid file causes a non-zero exit with a clear error message.

---

## Async batch workflow

For supported providers (`openai`, `anthropic`, `azure`), you can submit images to the provider's native Batch API and collect results later. This costs approximately half the synchronous per-image rate.

```bash
# Step 1: submit and exit (writes analysis_job.json)
vision-lens --async --input ./photos

# Step 2: poll until complete, then process normally
vision-lens --resume --input ./photos --output ./sorted
```

If the batch job fails, delete `analysis_job.json` and re-run without `--async`.

---

## Cost reference

Approximate per-image costs at the time of writing. Async batch is ~50% of the synchronous rate for supported providers.

| Provider / Model | Sync | Async |
|---|---|---|
| OpenAI `gpt-4o` (detail: low) | ~$0.001 | ~$0.0005 |
| Anthropic `claude-opus-4-7` | ~$0.0015 | ~$0.00075 |
| Google `gemini-2.0-flash` | ~$0.0003 | N/A |
| Ollama (local) | $0 | N/A |

Results are cached to `analysis_results.json`. Re-runs with `--skip-analysis` make no API calls.

Use `--estimate` to print a cost projection before running:

```bash
vision-lens --estimate --input ./photos
```

---

## Architecture and data flow

```
CLI flags
  └─ Config (Zod-validated)
       └─ EXIF timestamps (p-limit 32 concurrent) → FileWithStats[]
            └─ Perceptual hash dedup (dHash, on by default — --dedupe-threshold, 0 disables)
                 └─ LLM Vision batch analysis → AnalysisResult[]
                 │    (or: --async → analysis_job.json → exit)
                 │    (or: --resume → poll → collect results)
                 └─ Self-critique pass (if --self-critique)
                      └─ Temporal consensus voting (--temporal-window, --consensus-threshold)
                           └─ Session reconstruction (if --session-gap)
                                └─ Interactive review (if --interactive, requires TTY)
                                     └─ Cross-image linking (if --link)
                                          └─ Category sort + grouping
                                               └─ Sharp: resize + timestamp overlay + JPEG export
                                                    └─ Atomic write: analysis_results.json (tmp + rename)
                                                         └─ Plugin hooks (onRunComplete)
                                                              └─ Reports (CSV, HTML, XLSX, SQLite)
                                                                   └─ Webhook POST (if --webhook)
                                                                        └─ Cloud upload (if --output-bucket)
```

Key modules:

| Module | Role |
|---|---|
| `packages/cli/src/index.ts` | Commander.js entry point and help text — the `vision-lens` bin and every subcommand |
| `packages/core/src/config/` | Single source of truth: CLI flags > env vars > `.env` > defaults |
| `packages/core/src/analyzer/` | LLM Vision calls, temporal consensus, dedup, async batch, self-critique, linking |
| `packages/core/src/analyzer/providers/` | One file per LLM provider — the only files that import provider SDKs |
| `packages/core/src/processor/` | Sharp: image resize, timestamp overlay, JPEG export |
| `packages/core/src/classifier/` | Pure, synchronous: category grouping, sorting, rules — no I/O |
| `packages/core/src/reviewer/` | Interactive TTY review loop |
| `packages/core/src/reporter/` | HTML, CSV, XLSX, SQLite report writers |
| `packages/core/src/plugin/` | Lifecycle hook dispatcher |
| `packages/core/src/search/` | Semantic and keyword search over an analysed run |
| `packages/core/src/benchmark/` | Benchmark runner, metrics, calibration and the release gate |
| `packages/core/src/store/` | SQLite entity store, migrations and repositories |
| `packages/core/src/utils/` | Logger, retry with backoff, progress bar, EXIF reader, cost calculator |
| `packages/contracts/src/` | Zod domain entities, enums and the generated OpenAPI seed |
| `packages/sdk/src/index.ts` | Public SDK exports (`@vision-lens/sdk`) |
| `apps/api/`, `apps/studio/` | HTTP API and Studio surfaces (placeholders) |
| `services/vision/`, `services/training/`, `services/agents/` | Python services: encoders + LanceDB, training recipes + MLflow, agent runtime |

---

## SDK usage

`@vision-lens/sdk` exports a TypeScript SDK for programmatic use:

```typescript
import {
  runBatch,
  runReorder,
  runSingle,
  runSearch,
  runDiff,
  runSuggestCategories,
  loadConfig,
  buildSessions,
  runConsensus,
  diffCaches,
  FileRepository,
  NodeFileRepository,
  MemoryFileRepository,
  CACHE_SCHEMA_VERSION,
  PLUGIN_API_VERSION,
} from '@vision-lens/sdk';

const config = await loadConfig({ inputDir: './photos', outputDir: './sorted' });
await runBatch(config);
```

`MemoryFileRepository` is useful for testing — it keeps all files in memory without touching the filesystem.

---

## Project structure

```
packages/
  core/             Domain logic: config, analyzer, processor, classifier, reviewer,
                    reporter, plugin, search, benchmark, store, fs
  cli/              Commander.js CLI — the `vision-lens` bin plus the deprecated
                    `ai-image-labeling` compatibility bin
  sdk/              Public TypeScript SDK (@vision-lens/sdk)
  contracts/        Zod domain entities and the OpenAPI seed
apps/
  api/              HTTP API surface (placeholder)
  studio/           Studio review surface (placeholder)
services/
  vision/           Python skeleton: encoders + LanceDB
  training/         Python skeleton: training recipes + MLflow
  agents/           Python skeleton: agent runtime
benchmarks/         Benchmark fixtures and gold splits
datasets/           Dataset registry (license, source, checksums)
docs/               Architecture notes, ADRs, plugin API reference
examples/           Starter category configs (property, e-commerce, etc.)
scripts/            Fixture generation, benchmark harnesses, dataset tooling
specs/              Local-only spec-kit specs (untracked, per ADR-010)
```

Tests live next to the code they cover — `packages/*/tests/` and `apps/*/tests/`. There is no
root-level `src/` or `tests/` tree.

---

## Development

```bash
git clone https://github.com/erikunha/LAIbemage
cd LAIbemage
git checkout feat/visual-lens   # the monorepo layout lives on this branch, not on main
pnpm install
cp .env.example .env  # add at least one provider API key

pnpm run build          # compile TypeScript → dist/
pnpm run typecheck      # type-check without emitting
pnpm test               # run unit tests
pnpm run test:coverage  # with V8 coverage report
pnpm run lint           # ESLint
pnpm run lint:fix       # ESLint with auto-fix
pnpm run check          # lint + typecheck + coverage (full pre-PR gate)
```

Before opening a PR: `pnpm run lint && pnpm run typecheck && pnpm test` — all must pass.

See [CONTRIBUTING.md](CONTRIBUTING.md) for module boundary rules, how to add a provider, and the PR checklist.

---

## Contributing

PRs are welcome. Please:

1. Run `pnpm run lint && pnpm run typecheck && pnpm test` before opening a PR
2. Add or update tests for all new behavior
3. Follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`
4. Add new category taxonomies as `examples/categories-<domain>.json`

---

## License

MIT (c) Erik Cunha
