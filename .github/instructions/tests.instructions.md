---
applyTo: 'packages/*/tests/**,apps/*/tests/**'
---

# Tests rules
## Framework

Vitest 4 with globals enabled. All tests live under `packages/*/tests/` or `apps/*/tests/`, mirroring the `packages/*/src/` structure they cover.

## Mocking rules

- **DO NOT mock LLM SDK constructors directly** (`vi.mock('openai')`, `vi.mock('@anthropic-ai/sdk')`)
- **DO mock the `LLMClient` interface** from `packages/core/src/analyzer/client.ts` — pass a mock implementation
  directly to `analyzeBatch(filesWithStats, config, mockClient)` or similar
- Pure functions in `packages/core/src/classifier/` and `packages/core/src/processor/overlay.ts` need NO mocks at all
- Do NOT test `packages/cli/src/` or `packages/core/src/index.ts` — they are excluded from coverage
- Use `vi.useFakeTimers()` only when you also call `vi.runAllTimersAsync()` or
  `vi.advanceTimersByTimeAsync()` to advance the clock — otherwise pass `delayMs: 0` to real timers
- Reset mocks between tests: `vi.clearAllMocks()` in `beforeEach` or `afterEach`

## Config fixtures

Every `makeConfig()` helper and every inline Config object **must include all required fields**.
Do NOT use `as Config` to silence TypeScript — it hides missing field errors.

Required fields that are commonly missed:

```typescript
concurrency: 1,          // always 1 in tests — prevents non-deterministic concurrent ordering
estimate: false,
temporalWindowMinutes: 5,
consensusThreshold: 0.6,
dedupeThreshold: 0,      // 0 = disabled; prevents Sharp I/O in unit tests
forceSkipAnalysis: false,
asyncBatch: false,
resumeBatch: false,
timing: false,
watch: false,
watchPoll: false,
interactive: false,
plugins: [],
linkImages: false,
linkWindowDays: 7,
```

`AnalysisResult` fixtures must also include the v4 fields:

```typescript
fullDescription: '',     // max 250 chars; use '' as sentinel default in test factories
confidence: 0,           // 0–1; 0 = unknown/unparsed
extractedText: null,     // null when no visible text
```

A complete minimal fixture:

```typescript
function makeConfig(): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [],
      pinnedLast: [],
      immune: [],
      overridable: [],
      timezone: 'UTC',
    },
    apiKey: 'test',
    anthropicApiKey: '',
    googleApiKey: '',
    provider: 'openai',
    model: 'gpt-4o',
    batchSize: 20,
    maxRetries: 2,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    outputFormat: 'json',
    verbose: false,
    quiet: false,
    concurrency: 1,
    estimate: false,
    temporalWindowMinutes: 5,
    consensusThreshold: 0.6,
    dedupeThreshold: 0, // 0 = disabled in tests
    forceSkipAnalysis: false,
    asyncBatch: false,
    resumeBatch: false,
    logFormat: 'pretty',
    timing: false,
    filenameTemplate: '{n}. Photo of {category} dated {date}',
    watch: false,
    watchPoll: false,
    interactive: false,
    plugins: [],
    linkImages: false,
    linkWindowDays: 7,
  };
}
```

## Cache fixtures

When constructing mock `AnalysisCache` objects in tests, include all required fields:

```typescript
const mockCache: AnalysisCache = {
  schemaVersion: CACHE_SCHEMA_VERSION,
  processedDate: new Date().toISOString(),
  totalImages: 0,
  categories: [],
  categoriesHash: 'abc123', // required since schema v2
  images: [],
};
```

## Test file naming

`tests/[module]/[file].test.ts` — e.g. `packages/core/tests/analyzer/batch.test.ts` for `packages/core/src/analyzer/batch.ts`

## What to test

- Happy path
- Edge cases (empty input, single image, exact-threshold values)
- Error branches (API failure, quota exceeded, **malformed JSON response**, wrong-shape JSON)
- Zod schema rejection: pass an object missing `images` key to the batch envelope — assert warning logged
- Pure math functions exhaustively (font size clamping, timestamp formatting, SVG dimensions)

## Testing async batch

When testing `packages/core/src/analyzer/async-batch.ts`:

- Mock `AsyncBatchClient` directly — do not mock the provider SDK
- Construct `AsyncJobState` fixtures with all required fields:
  ```typescript
  const mockJobState: AsyncJobState = {
    jobId: 'batch_test_123',
    provider: 'openai',
    model: 'gpt-4o',
    submittedAt: new Date().toISOString(),
    status: 'submitted',
    outputDir: './output',
    imageCount: 3,
    batchSize: 20,
    customIds: ['batch-0'],
    fileOrder: ['a.jpg', 'b.jpg', 'c.jpg'],
  };
  ```
- Test the `migrateCache()` chain in `packages/core/src/store/migrate.ts` by passing raw v1/v2/v3 objects and asserting v4 shape; see `tests/utils/migrate.test.ts`

## Coverage thresholds (vitest.config.ts)

- Lines: 75%
- Functions: 85%
- Branches: 75%

Excluded from coverage (intentional):

- `packages/cli/src/**` — Commander.js wiring
- `packages/core/src/index.ts` — top-level orchestration
- `packages/core/src/analyzer/client.ts` — live SDK adapter
- `packages/core/src/analyzer/index.ts` — integration orchestration
- `packages/core/src/config/index.ts` — I/O + dotenv
- `packages/core/src/processor/exporter.ts`, `packages/core/src/processor/index.ts` — file I/O
- `packages/core/src/utils/progress.ts` — TTY/terminal UI
