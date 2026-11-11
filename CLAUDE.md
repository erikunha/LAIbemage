# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Vision Lens is a TypeScript ESM CLI tool that uses LLM Vision APIs (OpenAI, Anthropic, Google, Azure OpenAI, Ollama) to classify, timestamp, and organize images. It is domain-agnostic — the category taxonomy is supplied via a `categories.json` file at runtime.

## Commands

```bash
pnpm run build             # turbo build: compile workspace packages → packages/*/dist/
pnpm run typecheck         # type-check the workspace packages + scripts/ without emitting
pnpm run lint              # ESLint
pnpm run lint:fix          # ESLint with auto-fix
pnpm run format            # Prettier
pnpm test                  # Vitest unit tests (auto-generates fixtures first via pretest)
pnpm run test:watch        # Vitest in watch mode
pnpm run test:coverage     # with V8 coverage report
pnpm run check:boundaries  # proves the LLM-SDK boundary rule fires (eslint no-restricted-imports)
pnpm run test:py           # pytest for the Python services/ packages
pnpm run check             # lint + typecheck + coverage (full pre-PR suite)
```

Run a single test file:
```bash
pnpm exec vitest run packages/core/tests/analyzer/batch.test.ts
```

**Before any PR:** `pnpm run lint && pnpm run typecheck && pnpm test && pnpm run check:boundaries` — all must pass.

**Shell environment:** macOS M2 / fish shell. Never use bash `for/do/done` loop syntax in terminal commands — use fish-native syntax or direct commands (e.g. `for f in *.ts; pnpm run typecheck $f; end` or just call the pnpm script directly).

## Architecture

This is a pnpm + Turborepo monorepo: `packages/` holds the TypeScript code (`core`, `cli`, `sdk`, `contracts`), `apps/` holds the user-facing apps, `services/` holds the Python services. The full map is `docs/architecture/monorepo-map.md`.

### Module boundaries (strictly enforced)

| Module | Role | Key constraint |
|---|---|---|
| `packages/core/src/utils/` | Pure helpers (logger, retry, progress, exif, cost, mime, sanitize, feedback, webhook) | No LLM SDKs, no Sharp, no fs-extra; Node stdlib + chalk/cli-progress/file-type only |
| `packages/core/src/config/` | Config loading: CLI flags > env > .env > defaults | Single source of truth; Zod validates categories.json; owns the `LLMProvider` union and the `DEFAULT_MODEL` / `BILLING_URL` maps |
| `packages/core/src/analyzer/providers/*.ts` | **Only** files that import LLM SDKs (one SDK per file) | No processor/, classifier/, or other SDK cross-imports |
| `packages/core/src/analyzer/client.ts` | Thin routing layer — imports from `./providers/*` only | Never imports any LLM SDK directly; all other code uses `LLMClient` / `AsyncBatchClient` |
| `packages/core/src/analyzer/batch.ts` | Batch analysis + Zod envelope validation | May import Sharp for image resize |
| `packages/core/src/analyzer/dedup.ts` | Perceptual hash deduplication | May import Sharp for dHash |
| `packages/core/src/analyzer/async-batch.ts` | Async Batch API submit/resume | Uses `AsyncBatchClient`; may import Sharp |
| `packages/core/src/analyzer/temporal.ts` | Cluster consensus voting | Pure — no I/O, no SDKs |
| `packages/core/src/analyzer/linker.ts` | Cross-image relation linking pass | Uses `LLMClient` |
| `packages/core/src/analyzer/critique.ts` | Self-critique reclassification pass | Uses `LLMClient` |
| `packages/core/src/analyzer/embeddings.ts` | Text-embedding generation | Documented ESLint carve-out — may import `openai` and `@google/generative-ai` directly; Anthropic, Vertex and Bedrock stay forbidden |
| `packages/core/src/processor/` | Sharp image processing, JPEG export | No LLM SDKs |
| `packages/core/src/classifier/` | Pure grouping/sorting/rules — zero I/O, synchronous | No I/O, no SDKs, no Sharp |
| `packages/core/src/plugin/` | Lifecycle hook dispatcher | Dynamic import of `.mjs` plugins; isolates failures |
| `packages/core/src/reviewer/` | Interactive TTY review loop | Requires TTY; never mutates cache |
| `packages/core/src/reporter/` | CSV, HTML, XLSX, SQLite report generation | No LLM SDK imports; HTML must escape all LLM data |
| `packages/core/src/fs/` | `FileRepository` port + 5 adapters (Node, Memory, S3, GCS, AzureBlob) | All file I/O should route through this interface; `createFileRepository` is the factory |
| `packages/core/src/search/` | Semantic + keyword search over embeddings | No LLM SDKs, no Sharp |
| `packages/core/src/diff/` | Cache diffing | No LLM SDKs, no Sharp, no I/O |
| `packages/core/src/store/` | SQLite store, migrations, repositories | No LLM SDKs, no Sharp; schemas come from `@vision-lens/contracts` |
| `packages/core/src/benchmark/` | Benchmark runner, metrics, splits, gate | No LLM SDKs, no Sharp |
| `packages/contracts/src/` | Zod entities, enums, OpenAPI seed, fingerprint | `zod` only; no imports from core/, cli/, sdk/, apps/ |
| `packages/cli/src/` | Commander.js wiring only (`index.ts`, `help.ts`, `commands/`) | No business logic |
| `packages/sdk/src/index.ts` | Semver-stable public library API | All exports here are stable; internal paths (`packages/core/dist/analyzer/batch.js` etc.) are NOT stable |
| `packages/core/src/index.ts` | Top-level orchestration (`runBatch`, `runReorder`, `runSingle`) | No LLM SDKs, no Sharp; may import utility packages directly (`chokidar`, `p-limit`, `@vision-lens/contracts`) |
| `apps/*` | Placeholder apps (`api`, `studio`) | Placeholders only — `@vision-lens/sdk` once implemented |
| `services/*` | Python services (`vision`, `training`, `agents`) | Python stdlib + declared pyproject deps only; never import TS packages |

### Data flow

1. `packages/cli/src/` parses flags → `packages/core/src/config/` resolves and validates config (Zod schema for categories)
2. `packages/core/src/utils/exif.ts` reads EXIF timestamps concurrently (capped at 32 with `p-limit`) → `FileWithStats[]`
3. `packages/core/src/analyzer/dedup.ts` deduplicates burst frames via dHash (Hamming distance ≤ `dedupeThreshold`)
4. If `--async`: submit to provider Batch API → write `analysis_job.json` → exit; `--resume` polls until complete then continues from step 5
5. `packages/core/src/analyzer/batch.ts` sends batches to `LLMClient` with Zod envelope validation → `AnalyzedImage[]`
6. If `--self-critique`: `packages/core/src/analyzer/critique.ts` runs a reclassification pass on suspicious images
7. `packages/core/src/analyzer/temporal.ts` applies cluster consensus voting (`temporalWindowMinutes`, `consensusThreshold`)
8. If `--interactive`: `packages/core/src/reviewer/` enters TTY review loop → produces category overrides
9. `packages/core/src/classifier/` groups and sorts by category rules (`pinnedLast`, `immune`, `overridable`)
10. If `--link-images`: `packages/core/src/analyzer/linker.ts` runs cross-image relation linking pass
11. `packages/core/src/processor/overlay.ts` stamps red timestamp; `packages/core/src/processor/exporter.ts` renames and writes JPEG
12. Results written atomically to `analysis_results.json` via write-temp + rename (never truncate-in-place)
13. `packages/core/src/plugin/` dispatches `onRunComplete` hooks to loaded plugins
14. `packages/core/src/reporter/` writes CSV / HTML / XLSX / SQLite if requested

### Key type definitions (`packages/core/src/types.ts`)

- `AnalysisResult` — LLM output per image: `{ category, shortDescription, fullDescription, elements, confidence, extractedText }`
- `FileWithStats` → `AnalyzedImage` → `ProcessedResult` — progressive enrichment pipeline
- `AnalysisCache` / `PartialAnalysisCache` — on-disk JSON cache format
- `AsyncJobState` — on-disk state for `--async` / `--resume` workflow (`analysis_job.json`)
- `CACHE_SCHEMA_VERSION = 1` — increment when adding/removing cache fields (invalidates partial caches)
- `PLUGIN_API_VERSION = 1` — increment when the Plugin interface changes in a breaking way
- `AnalysisCache.categoriesHash` — SHA-256 (12 hex) of sorted category names; detects `categories.json` changes on `--skip-analysis`

### Config and interfaces are immutable

All fields on `Config`, `CategoryConfig`, `FileWithStats`, and `AnalyzedImage` are `readonly`.
Do not attempt to mutate them after construction.

### Key production dependencies

- `zod` — `categories.json` schema validation and LLM response envelope validation (`BatchEnvelopeSchema` in `packages/core/src/analyzer/batch.ts`)
- `p-limit` — caps concurrent EXIF reads (32) and concurrent API batch calls (`config.concurrency`, default 3)
- `sharp` — image resize (pre-API), perceptual hashing, and timestamp overlay; only in `packages/core/src/analyzer/batch.ts`, `packages/core/src/analyzer/dedup.ts`, `packages/core/src/analyzer/async-batch.ts`, `packages/core/src/analyzer/router.ts`, `packages/core/src/analyzer/suggest.ts`, `packages/core/src/analyzer/index.ts` and `packages/core/src/processor/exporter.ts`
- `exifr` — EXIF `DateTimeOriginal` extraction; only in `packages/core/src/utils/exif.ts` (dynamic import)
- `drizzle-orm` + `better-sqlite3` — typed SQLite writes in `packages/core/src/reporter/sqlite.ts` (optional; dynamic import)
- `chokidar` — file watching in `--watch` mode

## ESM import rule

All relative imports **must** use `.js` extension even though source files are `.ts`:

```typescript
import { logger } from './logger.js';  // correct
import { logger } from './logger';     // WRONG — breaks at runtime
```

## Testing conventions

- Tests live next to the code: `packages/core/tests/`, `packages/cli/tests/`, `packages/contracts/tests/`, `apps/api/tests/` and `apps/studio/tests/` — `packages/core/tests/` mirrors `packages/core/src/`
- Mock the `LLMClient` **interface** — do not mock individual SDK constructors (`vi.mock('openai')` etc.)
- Pure functions (classifier, overlay math) need no mocks
- Coverage is measured over `packages/core/src/` only. Excluded from it (see `vitest.config.ts`): `packages/core/src/index.ts`, `packages/core/src/analyzer/client.ts`, `packages/core/src/analyzer/index.ts`, `packages/core/src/analyzer/suggest.ts`, `packages/core/src/analyzer/providers/`, `packages/core/src/reporter/port.ts`, `packages/core/src/reporter/factory.ts`, `packages/core/src/reporter/xlsx.ts`, `packages/core/src/reporter/adapters/`, `packages/core/src/fs/`, `packages/core/src/config/index.ts`, `packages/core/src/processor/exporter.ts`, `packages/core/src/processor/index.ts`, `packages/core/src/utils/progress.ts` and `packages/core/src/types.ts`
- All `Config` fixtures must include **all** required fields — never use `as Config` to suppress errors
- Coverage thresholds: lines 75%, functions 85%, branches 75%

### Required Config fields (all must be present in test fixtures)

```typescript
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [{ name: 'kitchen', description: 'Kitchen area' }],
      pinnedLast: [],
      immune: [],
      overridable: [],
      timezone: 'UTC',
    },
    provider: 'openai',
    apiKey: 'test-key',
    anthropicApiKey: '',
    googleApiKey: '',
    azureEndpoint: '',
    azureApiKey: '',
    ollamaUrl: 'http://localhost:11434',
    bedrockRegion: 'us-east-1',
    bedrockAccessKeyId: '',
    bedrockSecretAccessKey: '',
    vertexProjectId: '',
    vertexLocation: 'us-central1',
    model: 'gpt-4o',
    batchSize: 5,
    maxRetries: 2,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
    asyncBatch: false,
    resumeBatch: false,
    outputFormat: 'json',
    logFormat: 'pretty',
    verbose: false,
    quiet: false,
    concurrency: 1,       // always 1 in tests
    estimate: false,
    temporalWindowMinutes: 5,
    consensusThreshold: 0.6,
    dedupeThreshold: 0,
    timing: false,
    filenameTemplate: '{n}. {description} dated {date}.{ext}',
    watch: false,
    watchPoll: false,
    interactive: false,
    plugins: [],
    linkImages: false,
    linkWindowDays: 7,
    selfCritique: false,
    learn: false,
    localModel: 'llava',
    cloudProvider: 'openai',
    localConfidenceThreshold: 0.7,
    embed: false,
    sessionGapMinutes: undefined,
    consensusProviders: undefined,
    webhookUrl: undefined,
    outputBucket: undefined,
    activeLearnQueue: false,
    ...overrides,
  };
}
```

### AnalysisResult fixture fields

```typescript
// Required — do NOT include removed domain-specific fields (condition, defects, severity, locationWithinCategory)
const result: AnalysisResult = {
  category: 'kitchen',
  shortDescription: 'Clean kitchen with modern appliances',
  fullDescription: '',  // max 250 chars; use '' as default in test factories
  elements: ['sink', 'tiles'],
  confidence: 0,        // 0–1; use 0 as sentinel default in test factories
  extractedText: null,
};
```

## LLM client patterns

- Wrap all LLM calls in `withRetry()` from `packages/core/src/utils/retry.ts`
- Use `detail: 'low'` for batch analysis, `detail: 'high'` for reclassification passes
- Quota/credit errors must not be retried (handled in `packages/core/src/utils/retry.ts`)
- Default models: `gpt-4o` / `claude-opus-4-7` / `gemini-2.0-flash`
- Always validate the LLM JSON response shape with Zod before accessing fields

## Async batch workflow

- `--async`: submit images to provider's Batch API → write `analysis_job.json` → exit
- `--resume`: read `analysis_job.json`, poll until complete, collect results, then process normally
- Supported providers for async: `openai` (Batch API), `anthropic` (Message Batches)
- If `status: 'failed'` — delete `analysis_job.json` and re-run without `--async`

## Category system

- Default config: `examples/categories.json`; validated via `CategoryConfigSchema` at load time
- Never hardcode category names outside `examples/` and test fixtures
- `immune` — never overridden by temporal consensus
- `overridable` — can be overridden by temporal consensus (threshold set via `--consensus-threshold`, default 0.6)
- `pinnedLast` — sorted to end of output
- Category names must be `lowercase_snake_case` — enforced by Zod schema

## Plugin system

- External plugins are `.mjs` files loaded via `--plugin <path>`
- Interface: `{ name: string, onImageAnalysed?, onImageProcessed?, onRunComplete? }`
- All hooks are optional and async; failures are caught and logged — never abort the run
- `PLUGIN_API_VERSION = 1` — plugins should assert this at load time

## Security rules

- Never hardcode API keys in source files — always use env vars
- HTML reporter: every LLM-sourced field **must** be HTML-escaped before embedding (XSS risk)
- Plugin paths: resolve to absolute path before dynamic import; never pass to `eval` or `exec`
- Validate `category` against the known category list before using as a filesystem path

## Commit conventions

Conventional Commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`

## Adding a new feature

1. Update types in `packages/core/src/types.ts` if data shapes change; if `AnalysisCache`/`PartialAnalysisCache` fields change, increment `CACHE_SCHEMA_VERSION`
2. Add `readonly` CLI flag field to `Config` in `packages/core/src/config/index.ts`, wire in `loadConfig()`, add to `packages/cli/src/index.ts` (Commander) and `packages/cli/src/help.ts`
3. Implement logic in the appropriate `packages/core/src/` module (respecting boundaries above)
4. Add tests in `packages/core/tests/` mirroring the `packages/core/src/` path; add new Config fields to all test fixtures
5. Update `README.md` CLI reference table
6. If adding new cache fields, use `.github/prompts/schema-migration.prompt.md` as the checklist

## Claude Code agents (`.claude/agents/`)

Invoke specialist sub-agents for focused tasks:

| Agent | When to invoke |
|---|---|
| `contributor` | Default for all feature/fix work |
| `code-reviewer` | Before every merge |
| `security-auditor` | Before release; when touching cache, HTML, or plugins |
| `dx-engineer` | When error messages, help text, or exit codes need review |
| `dependency-auditor` | Before release; when adding or upgrading any dependency |
| `refactoring-guardian` | Tech debt, dead code, module boundary drift |
| `migration-engineer` | `CACHE_SCHEMA_VERSION` bumps, CLI flag renames |
| `test-author` | When coverage drops below thresholds; after a new module |
| `data-integrity` | When touching cache serialisation or partial-flush path |
| `analyzer-tuner` | High unknown rate, poor accuracy, high API cost |
| `performance-profiler` | Sharp pipeline or batch throughput bottlenecks |
| `plugin-author` | When writing an external `.mjs` plugin |
| `incident-responder` | Corrupt cache, partial run, wrong sequence numbers |
| `category-architect` | New image domain onboarding |
| `docs-writer` | After CLI changes or new features |
| `release-engineer` | Cutting a release |
| `explore` | Fast read-only codebase Q&A |
