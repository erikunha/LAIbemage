---
paths:
  - packages/core/src/utils/**
---

# Utils module rules
## Purpose

Pure helpers with no side effects. Every function must be fully unit-testable without mocks.

## Module boundary (BLOCK on violation)

- NO imports of any LLM SDK, Sharp, or `fs-extra`
- NO direct `process.exit()` — callers are responsible for exiting
- `console.log` / `console.error` are allowed ONLY in `logger.ts` and `progress.ts`
- All other utils must be side-effect-free (no I/O, no global state mutation)

## Files and responsibilities

### `logger.ts`

Single `logger` object with `info`, `success`, `warn`, `error`, `verbose`, `raw` methods.
Module-level `_quiet` and `_verbose` flags configured once via `configureLogger()`.
Never add new log levels without updating the `LogLevel` type.

### `progress.ts`

CLI progress bar (cli-progress) and summary table. Manages a single `bar` singleton.
`startProgress` / `updateProgress` / `stopProgress` control the bar lifecycle.
`printSummaryTable` is independent of the bar — can be called after `stopProgress`.

### `retry.ts`

`withRetry<T>(fn, options)` — retries with linear back-off.

- Always throw `new Error(...)` — never throw strings
- Quota errors must NOT be retried — detect all three providers (OpenAI, Anthropic, Google)
- 429 rate-limit errors retry with constant delay; generic errors retry with linear back-off
- `sleep(ms)` is exported for use in batch processing

### `exif.ts`

`getImageTimestamp(fullPath)` — returns `{ createdAt: number, exifSource: ExifSource }`.
Priority: EXIF DateTimeOriginal → birthtime → ctime.
Uses dynamic `import('exifr')` so the module stays tree-shakeable.
Falls through on exifr parse failure — never throws.

### `cost.ts`

Token-cost estimation for the `--estimate` flag.

- `PROVIDER_PRICING`, `TOKENS_PER_IMAGE`, `PROMPT_OVERHEAD_TOKENS`, `OUTPUT_TOKENS_PER_IMAGE` are module-level `const` exports
- `estimateCost(imageCount, batchSize, provider, detail?)` — pure, no I/O
- `formatCostRow(estimate)` — pure, returns a string, no console output
- `printCostEstimate(imageCount, batchSize, detail?)` — the only function here that writes to stdout

## Testing

All utils except `logger.ts` and `progress.ts` are pure — test them without mocks.
For `retry.ts` tests, pass `delayMs: 0` to avoid real waits (do not use fake timers unless testing time-based behavior explicitly).
