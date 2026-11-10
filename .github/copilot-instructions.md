# GitHub Copilot Instructions — ai-image-labeling

## Project overview

This is a TypeScript CLI tool that uses LLM Vision APIs (OpenAI, Anthropic, Google, Azure OpenAI,
Ollama) to classify, timestamp, and organize images. It is designed to be domain-agnostic: any
category taxonomy can be supplied via `categories.json`, and any supported LLM provider can be
selected at runtime.

## Language and style

- All code, comments, commit messages, PR descriptions, and documentation must be in **English**
- TypeScript strict mode — no `any`, no `as unknown as X` unless absolutely necessary
- ESM only: all relative imports must use `.js` extension (e.g., `import { foo } from './bar.js'`)
- NodeNext module resolution — required for correct ESM behavior
- Prettier for formatting (singleQuote, trailingComma: "all", printWidth: 100)
- **macOS M2 / fish shell** — never use bash `for/do/done` loop syntax in terminal commands; use fish-native syntax or direct commands

## Architecture rules

- **`src/utils/`** — Pure helpers with no side effects. Fully unit-testable without mocks.
- **`src/analyzer/providers/*.ts`** — One file per provider. The ONLY files that import LLM SDKs. `src/analyzer/client.ts` is the routing layer — it imports from `./providers/` and exposes the `LLMClient` interface.
- **`src/analyzer/`** — All LLM calls live here via `LLMClient`. Must be mockable in tests. May import Sharp only in `batch.ts` (resize helper) and `dedup.ts` (perceptual hash).
- **`src/processor/`** — All Sharp image processing lives here. Never import any LLM SDK.
- **`src/classifier/`** — Pure functions: grouping, sorting, rule evaluation. Zero I/O.
- **`src/config/`** — Single source of truth for runtime config. CLI flags > env vars > .env > defaults.
- **`src/cli/`** — Commander.js wiring only. No business logic.
- **`src/plugin/`** — Lifecycle hook dispatcher. Loads external `.mjs` plugins via dynamic import. Isolates all hook failures with try/catch — never throws. See `plugin.instructions.md`.
- **`src/reviewer/`** — Interactive TTY review loop. TTY guard required. Returns `ReviewResult` without mutating the cache. See `reviewer.instructions.md`.
- **`src/reporter/`** — CSV, HTML, XLSX report generation. HTML output must HTML-escape all LLM data. No LLM SDK imports. See `reporter.instructions.md`.
- **`src/fs/`** — `FileRepository` port + 5 adapters (Node, Memory, S3, GCS, AzureBlob). All persistent file I/O should route through this interface. `createFileRepository` is the factory.
- **`packages/sdk/src/index.ts`** — Semver-stable public library API. All exports here are stable; internal module paths (`dist/analyzer/batch.js` etc.) are NOT stable.
- **`src/index.ts`** — Top-level orchestration exported functions: `runBatch`, `runReorder`, `runSingle`.
- **`scripts/`** — Developer utilities run via `tsx`. Never compiled to `dist/`. See `scripts.instructions.md`.

## Module boundary table

| Module                   | Allowed imports                                        | Forbidden imports                                           |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| `src/utils/`             | Node stdlib only                                       | OpenAI, Sharp, fs-extra                                     |
| `src/analyzer/client.ts`       | utils/, config/, types, src/analyzer/providers/*       | processor/, classifier/, any LLM SDK directly               |
| `src/analyzer/providers/*.ts`  | single provider SDK, utils/, config/, types            | other SDKs, processor/, classifier/                         |
| `src/analyzer/`                | utils/, config/, types, LLMClient, Sharp (resize only) | processor/, classifier/, any LLM SDK directly               |
| `src/processor/`         | utils/, config/, types, Sharp                          | any LLM SDK, analyzer/                                      |
| `src/classifier/`        | config/, types                                         | any LLM SDK, Sharp, fs-extra                                |
| `src/plugin/`            | utils/, types                                          | any LLM SDK, Sharp, fs-extra, src/analyzer/, src/processor/ |
| `src/reviewer/`          | utils/, config/, types, @inquirer/\*                   | any LLM SDK, Sharp                                          |
| `src/reporter/`          | utils/, types, fs-extra, exceljs                       | any LLM SDK, Sharp, src/analyzer/                           |
| `src/fs/`                | Node stdlib, cloud SDKs (per adapter)                  | LLM SDKs, Sharp, src/analyzer/                              |
| `src/cli/`               | config/, index, utils/logger                           | analyzer/, processor/, classifier/                          |
| `src/index.ts`           | All src/ modules                                       | external packages directly                                  |

## Security

- Never hardcode API keys in source files. Always use env vars or the provider-specific CLI flag.
- Validate API key presence at startup with a helpful error pointing to the correct billing page.
- Do not log API keys, even at verbose/debug level.
- Provider keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `AZURE_API_KEY`
- **HTML reporter**: every LLM-sourced field MUST be HTML-escaped before embedding — treat LLM output as untrusted input (XSS risk)
- **Plugin paths**: resolve to absolute path before dynamic import; never pass to `eval` or `exec`

## LLM client patterns

- All LLM calls go through `LLMClient` from `src/analyzer/client.ts`
- Use `detail: 'low'` for batch analysis (cost efficiency), `detail: 'high'` for reclassification passes
- Always wrap LLM calls in `withRetry()` from `src/utils/retry.ts`
- Handle quota/credit errors immediately (do not retry) — all providers are detected in `retry.ts`
- Supported providers:
  - `openai` (default: `gpt-4o`) — requires `OPENAI_API_KEY`
  - `anthropic` (default: `claude-opus-4-7`) — requires `ANTHROPIC_API_KEY`
  - `google` (default: `gemini-2.0-flash`) — requires `GOOGLE_API_KEY`
  - `azure` (default: model from `--azure-deployment`) — requires `AZURE_API_KEY` + `--azure-endpoint`
  - `ollama` (default: `llama3.2-vision`) — no key required; requires `--ollama-url` (default: `http://localhost:11434`)
  - `bedrock` (Claude via AWS IAM) — requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `--bedrock-region`
  - `vertex` (Gemini via GCP ADC) — requires `--vertex-project`, `--vertex-location`

## Plugin API

- External plugins are `.mjs` files loaded via `--plugin <path>`
- Plugin interface: `{ name: string, onImageAnalysed?, onImageProcessed?, onRunComplete? }`
- All hooks are optional and async (`Promise<void>`)
- `PLUGIN_API_VERSION = 1` — plugins should assert this at load time
- `CACHE_SCHEMA_VERSION = 1` — increment when adding/removing fields from `AnalysisCache`
- Never pass API keys or the full `Config` object to plugin hooks

## Testing

- All tests live in `tests/` mirroring the `src/` structure
- Mock the `LLMClient` interface — do not mock individual SDK constructors in new tests
- Pure functions (classifier, overlay math, CSV builder) should be tested without mocks
- Do not test `src/cli/` or `src/index.ts` (excluded from coverage)
- Config test fixtures must include ALL required `Config` fields — never use `as Config` to suppress errors
- Required fields commonly missed: `concurrency: 1`, `estimate: false`, `temporalWindowMinutes: 5`, `consensusThreshold: 0.6`, `dedupeThreshold: 0`, `interactive: false`, `plugins: []`, `asyncBatch: false`, `resumeBatch: false`, `forceSkipAnalysis: false`, `activeLearnQueue: false`, `embed: false`, `sessionGapMinutes: undefined`, `consensusProviders: undefined`
- `AnalysisResult` fixtures must include `fullDescription: ''`, `confidence: 0`, and `extractedText: null` — do NOT include `condition` (removed as domain-specific)
- Coverage thresholds: lines 75%, functions 85%, branches 75%

## Category system

- Categories are loaded from `examples/categories.json` by default
- The LLM prompt is built dynamically from `config.categoryConfig.categories`
- Do NOT hardcode category names outside of `examples/` and test fixtures
- All category names must be `lowercase_snake_case` — enforced by Zod schema
- `immune` — never overridden by temporal consensus
- `overridable` — can be overridden by temporal consensus (threshold: `--consensus-threshold`, default 0.6)
- `pinnedLast` — sorted to end of output (use for `unknown`, `unusable`)

## Benchmark

- `scripts/benchmark.ts` measures precision, recall, unknown-rate, cost, and P95 latency per provider
- Fixtures: `tests/fixtures/benchmark/` (24 synthetic images + `labels.json` + `baseline.json`)
- Baseline is git-tracked; update with `--update-baseline` flag after intentional improvements
- Regression threshold: 5% on any metric vs baseline → exit 1 on `--check-regression`

## Agent roster (`.github/agents/`)

Invoke the right specialist agent for each task:

| Agent                    | When to invoke                                                                  |
| ------------------------ | ------------------------------------------------------------------------------- |
| `Contributor`            | Default for all feature/fix work                                                |
| `Dev Reviewer`           | Before every merge                                                              |
| `Security Auditor`       | Before release; when touching cache, HTML, or plugins                           |
| `DX Engineer`            | When error messages, help text, progress output, or exit codes need review      |
| `Dependency Auditor`     | Before release; when adding or upgrading any npm dependency                     |
| `Refactoring Guardian`   | Tech debt, dead code, module boundary drift                                     |
| `Migration Engineer`     | `CACHE_SCHEMA_VERSION` bumps, CLI flag renames/removals, major provider changes |
| `Test Author`            | When coverage drops below thresholds; after a new module                        |
| `Data Integrity Auditor` | When touching cache serialisation or partial-flush path                         |
| `Analyzer Tuner`         | High unknown rate, poor accuracy, high API cost                                 |
| `Performance Profiler`   | Sharp pipeline or batch API throughput bottlenecks; profile with clinic.js before implementing H15 worker thread pool |
| `Plugin Author`          | When writing an external `.mjs` plugin                                          |
| `Incident Responder`     | Corrupt cache, partial run, wrong sequence numbers                              |
| `Category Architect`     | New image domain onboarding                                                     |
| `Docs Writer`            | After CLI changes or new features                                               |
| `Release Engineer`       | Cutting a release                                                               |
| `Explore`                | Fast read-only codebase Q&A                                                     |

## Subcommands

Key subcommands to know:
- `search` — semantic or keyword search on classified images; requires `--embed` for semantic mode
- `diff <before> <after>` — compare two `analysis_results.json` files
- `suggest-categories` — sample images and ask LLM to propose a `categories.json` taxonomy

## Commit conventions

Follow Conventional Commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`
