---
paths:
  - packages/core/src/analyzer/**
  - packages/core/src/analyzer/*.ts
---

# Analyzer module rules
## Purpose

This module owns all LLM API calls via the `LLMClient` abstraction in `client.ts`.
It may import Sharp only in `batch.ts` (resize before API call) and `dedup.ts` (perceptual hash).
It must never import any LLM SDK directly — use `LLMClient` from `./client.js`.
`packages/core/src/analyzer/async-batch.ts` may also import Sharp (image encoding) and uses the `AsyncBatchClient`
interface from `client.ts`; it never imports any LLM SDK directly.

## LLM client architecture

- `packages/core/src/analyzer/providers/*.ts` are the **only** files that import LLM SDKs. Each file imports one SDK. `packages/core/src/analyzer/client.ts` is a thin routing layer that imports from `./providers/` — it does NOT import any LLM SDK directly.
- All other files in this module receive an `LLMClient` instance as a parameter
- `LLMClient` interface: `complete(prompt: string, images: ImageInput[], opts: CompleteOptions): Promise<CompleteResult>`
- `ImageInput = { base64: string, label: string }`
- `CompleteOptions = { maxTokens: number, detail?: 'low' | 'high' }`
- `CompleteResult = { text: string, tokensUsed: number }`

## Key invariants

- `analyzeBatch()` sends images in chunks of `config.batchSize` (default 20)
- Always use `detail: 'low'` for batch calls (cost ~85 tokens/image)
- Always use `detail: 'high'` for reclassification passes (second pass for `unknown` images)
- Always wrap LLM calls in `withRetry()` from `../utils/retry.js`
- Throw immediately (do not retry) on quota/credit exhaustion — all three providers detected in `retry.ts`
- Fill failed batch slots with `unknown` placeholders — never surface raw API errors to the user

## Perceptual deduplication (`dedup.ts`)

- Runs before the batch pass to skip near-identical burst frames
- Uses dHash (9×8 → 64-bit difference hash via Sharp)
- Configurable via `config.dedupeThreshold` (Hamming distance 0–64; 0 = disabled, default 8)
- 60-second burst window — only compares images within that window
- `deduplicateImages()` accepts an injectable `hashFn` parameter for testability

## Temporal consensus (`temporal.ts`)

- Cluster window: `config.temporalWindowMinutes` (default 5, CLI: `--temporal-window`)
- Override threshold: `config.consensusThreshold` (default 0.6, CLI: `--consensus-threshold`)
- `immune` categories (e.g. `payment_receipt`) are NEVER overridden
- `overridable` categories (e.g. `unknown`) CAN be overridden

## AnalysisResult shape

Fields returned by the LLM and stored in the cache:

```typescript
interface AnalysisResult {
  category: string; // matched category name or 'unknown'
  shortDescription: string; // 1–2 sentence description of the image
  fullDescription: string; // detailed description, max 250 chars; '' when not provided
  elements: string[]; // key visual elements (objects, features)
  confidence: number; // 0–1 self-reported model confidence (0 = unknown/unparsed)
  extractedText: string | null; // visible text in the image (OCR); null if none
}
```

Sentinel defaults for unknown/failed images:

```typescript
{ category: 'unknown', shortDescription: 'unanalyzed image', fullDescription: '', elements: [], confidence: 0, extractedText: null }
```

`CACHE_SCHEMA_VERSION = 1` — increment in `packages/core/src/types.ts` whenever `AnalysisCache` fields change.
Migration chain lives in `packages/core/src/store/migrate.ts` as `migrateCache(raw: unknown): AnalysisCache`.

## Adding a new analysis pass

1. Add the function in `packages/core/src/analyzer/index.ts`
2. Accept `client: LLMClient` as a parameter — never create clients inside analysis functions
3. Export if reusable
4. Add tests in `packages/core/tests/analyzer/` — mock via the `LLMClient` interface, not SDK constructors
5. Keep it mockable: use `vi.fn()` on `LLMClient.complete` in tests

## Async batch

`packages/core/src/analyzer/async-batch.ts` handles the `--async` submit → `--resume` collect workflow:

- `submitAsyncBatch(filesWithStats, config, asyncClient)` — encodes images, builds batch requests, submits to the provider's async API; returns `AsyncJobState` written to `analysis_job.json`
- `resumeAsyncBatch(state, asyncClient)` — polls `asyncClient.checkStatus()` until complete, retrieves results, returns `AnalysisResult[]`
- `AsyncBatchClient` interface (defined in `client.ts`): `submitBatch()`, `checkStatus()`, `retrieveResults()`
- Call `migrateCache()` from `packages/core/src/store/migrate.ts` when reading any `AnalysisCache` from disk — never assume the schema version is current
- Provider support: OpenAI (Batch API) and Anthropic (Message Batches); Google/Azure/Ollama not supported
