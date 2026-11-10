# AGENTS.md — AI Agent Guidance for ai-image-labeling

This file guides AI coding agents (Claude Code, GitHub Copilot, etc.) working in this repository.

## Build & test commands

```bash
pnpm run build          # compile TypeScript → dist/
pnpm run typecheck      # type-check without emitting
pnpm run lint           # ESLint
pnpm run lint:fix       # ESLint with auto-fix
pnpm run format         # Prettier
pnpm test               # Vitest unit tests (fixtures auto-generated via pretest hook)
pnpm run test:coverage  # with V8 coverage report
pnpm run check          # lint + typecheck + coverage (full pre-PR suite)
```

**Before any PR:** run `pnpm run lint && pnpm run typecheck && pnpm test` — all must pass.

## Module boundaries

| Directory | Allowed imports | Forbidden imports |
|---|---|---|
| `src/utils/` | Node stdlib only | OpenAI, Sharp, fs-extra |
| `src/analyzer/providers/*.ts` | utils/, config/, types, the single provider SDK for that file | processor/, classifier/, other provider SDKs |
| `src/analyzer/client.ts` | utils/, config/, types, `src/analyzer/providers/` | any LLM SDK directly, processor/, classifier/ |
| `src/analyzer/batch.ts` | utils/, config/, types, LLMClient, Sharp (resize) | LLM SDKs directly, processor/ |
| `src/analyzer/dedup.ts` | utils/, config/, types, Sharp (dHash) | LLM SDKs directly, processor/ |
| `src/analyzer/async-batch.ts` | utils/, config/, types, AsyncBatchClient, Sharp | LLM SDKs directly, processor/ |
| `src/analyzer/temporal.ts` | config/, types | any LLM SDK, Sharp, I/O |
| `src/analyzer/linker.ts` | utils/, config/, types, LLMClient | LLM SDKs directly, processor/ |
| `src/analyzer/critique.ts` | utils/, config/, types, LLMClient | LLM SDKs directly, processor/ |
| `src/processor/` | utils/, config/, types, Sharp | any LLM SDK, analyzer/ |
| `src/classifier/` | config/, types | any LLM SDK, Sharp, fs-extra |
| `src/plugin/` | utils/, types | any LLM SDK, Sharp, fs-extra, analyzer/, processor/ |
| `src/reviewer/` | utils/, config/, types, @inquirer/* | any LLM SDK, Sharp |
| `src/reporter/` | utils/, types, fs-extra, exceljs, drizzle-orm (dynamic) | any LLM SDK, Sharp, analyzer/ |
| `src/fs/` | Node stdlib, cloud SDKs (per adapter) | LLM SDKs, Sharp, analyzer/ |
| `src/sdk.ts` | All src/ modules (re-exports only) | nothing — stable re-export surface only |
| `src/cli/` | config/, index, utils/logger | analyzer/, processor/, classifier/ |
| `src/index.ts` | All src/ modules | external packages directly |

`src/analyzer/client.ts` is a thin routing layer. It must not import any provider SDK directly — all SDK imports live in `src/analyzer/providers/<provider>.ts`.

## ESM import rule

All relative imports must end in `.js` even when the source file is `.ts`:

```typescript
import { logger } from './logger.js'; // correct
import { logger } from './logger';    // WRONG — breaks at runtime
```

## Key types

- `AnalysisResult` — LLM output: `{ category, shortDescription, fullDescription, elements, confidence, extractedText }`
- `ProcessedResult` — final per-image record in `analysis_results.json`
- `AnalysisCache` / `PartialAnalysisCache` — on-disk JSON cache
- `AsyncJobState` — on-disk `analysis_job.json` for `--async` / `--resume`
- `CACHE_SCHEMA_VERSION = 1` — increment when adding/removing `AnalysisCache` fields
- `PLUGIN_API_VERSION = 1` — increment when `Plugin` interface changes

## Config fixture pattern (use in every test)

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
    concurrency: 1,
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

## AnalysisResult fixture fields

```typescript
// Do NOT include removed fields: condition, defects, severity, locationWithinCategory
const result: AnalysisResult = {
  category: 'kitchen',
  shortDescription: 'Clean kitchen',
  fullDescription: '',   // max 250 chars; use '' as sentinel default in factories
  elements: ['sink', 'tiles'],
  confidence: 0,         // sentinel default in factories
  extractedText: null,
};
```

## Adding a new feature checklist

1. Update types in `src/types.ts` first; increment `CACHE_SCHEMA_VERSION` if cache fields change
2. Add `readonly` CLI flag to `Config` + `RawCliOptions` in `src/config/index.ts`, wire `loadConfig()`
3. Add to `src/cli/index.ts` (Commander) and `src/cli/help.ts`
4. Implement logic in the correct `src/` module — respect boundaries above
5. Add tests in `tests/` mirroring `src/`; update all Config fixtures with new fields
6. Update `README.md` CLI reference table
7. Run `pnpm run check` — all must pass

## Do NOT

- Import any LLM SDK outside `src/analyzer/providers/*.ts`
- Import Sharp in `src/analyzer/` except in `batch.ts`, `dedup.ts`, `async-batch.ts`
- Hardcode category names outside `examples/*.json` and test fixtures
- Use `any` type without an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment
- Add `console.log` outside `src/utils/logger.ts` and `src/utils/progress.ts`
- Embed LLM output in HTML without HTML-escaping (XSS risk)
- Write directly to `analysis_results.json` — always write-temp + rename

## Agent roster

### Claude Code agents (`.claude/agents/`)

| Agent | Role | When to invoke |
|---|---|---|
| `contributor` | General feature/fix implementer | Default for all coding work |
| `code-reviewer` | Code audit before merge | After every PR / before release |
| `security-auditor` | Threat model audit | Before release; touching cache, HTML, plugins |
| `dx-engineer` | CLI UX audit | Error messages, help text, exit codes |
| `dependency-auditor` | Supply chain audit | Before release; adding/upgrading deps |
| `refactoring-guardian` | Structural refactor | Tech debt, dead code, boundary drift |
| `migration-engineer` | Breaking changes | CACHE_SCHEMA_VERSION bumps, flag renames |
| `test-author` | Unit test coverage | Coverage drops; after a new module |
| `data-integrity` | Cache write safety | Touching cache serialisation or partial-flush |
| `analyzer-tuner` | LLM prompt quality + cost | High unknown rate, poor accuracy, high cost |
| `performance-profiler` | Sharp + batch profiling | Throughput bottlenecks |
| `plugin-author` | External plugin scaffolding | Writing a `.mjs` plugin |
| `incident-responder` | Production crash recovery | Corrupt cache, partial run, wrong numbers |
| `category-architect` | Domain taxonomy design | New image domain onboarding |
| `docs-writer` | README + CLI reference | After CLI changes; new features |
| `release-engineer` | Versioning + publish | Cutting a release |
| `explore` | Read-only codebase Q&A | Fast answers without editing |

### GitHub Copilot agents (`.github/agents/`)

Same roster — see `.github/copilot-instructions.md` for Copilot-specific invocation.

## Spec-kit workflow (Master evolution)

The Master evolution (ADR-005+) is planned with spec-kit. Specs, plans, tasks and research
live under `specs/` and `.specify/` — **never tracked in git** (ADR-010; the maintainer's
global git ignore enforces it). The constitution binding every spec is
`.specify/memory/constitution.md` (local only).

Route a feature needing a written spec through speckit in order: **specify → clarify → plan
→ tasks → implement → analyze**; each step reads the previous output. The tracked mirrors of
the plan are `docs/adr/` (decisions, numbering continues at 005) and `ROADMAP.md` (phase and
spec status). The spec index with the phase map (F0–F5 → specs 001–014) is `specs/README.md`.

When implementing from a spec: honor the constitution principles (evidence over vibes,
Prediction ≠ Annotation, full-config fingerprints, calibrated uncertainty, untrusted visual
content, cost as a first-class metric), keep the six quality gates green, and update every
doc that describes what changed in the same commit.
