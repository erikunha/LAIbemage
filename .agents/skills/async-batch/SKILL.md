---
name: async-batch
description: Use when a user wants to submit a large image set (hundreds to thousands of images) to a provider async batch API without blocking the terminal, take advantage of provider batch pricing, or resume and collect the results of a previously submitted batch job.
---

# Skill: Async Batch Submission

**Domain:** Submitting large image sets to provider async APIs and collecting results later

## When to use this skill

Use this skill when a user wants to:

- Process a large image set (hundreds to thousands of images) without blocking the terminal
- Take advantage of provider batch pricing (OpenAI Batch API: 50% cost reduction)
- Submit during off-peak hours and collect results later

## Provider support matrix

| Provider    | Async API         | Notes                                           |
| ----------- | ----------------- | ----------------------------------------------- |
| `openai`    | Batch API (JSONL) | 50% cost reduction; 24h completion window       |
| `anthropic` | Message Batches   | Standard pricing; results available for 29 days |
| `google`    | Not supported     | Use synchronous mode                            |
| `azure`     | Not supported     | Use synchronous mode                            |
| `ollama`    | Not supported     | Local only; use synchronous mode                |

## Step 1 — Submit the batch

```bash
node dist/cli/index.js \
  --async \
  --input ./input \
  --output ./output \
  --provider openai \
  --api-key $OPENAI_API_KEY
```

This encodes all images, submits to the provider's batch API, writes `analysis_job.json` to
`--output`, and exits immediately. No classification or file output is produced yet.

## Step 2 — Resume when complete

```bash
node dist/cli/index.js \
  --resume \
  --output ./output \
  --provider openai \
  --api-key $OPENAI_API_KEY
```

This reads `analysis_job.json`, polls the provider until the job is complete (checking every
30 seconds), retrieves results, then runs the full classify → process → export pipeline.

## What `analysis_job.json` contains (`AsyncJobState`)

```typescript
interface AsyncJobState {
  jobId: string; // provider-assigned batch job ID
  provider: 'openai' | 'anthropic';
  model: string;
  submittedAt: string; // ISO 8601 timestamp
  status: 'submitted' | 'pending' | 'complete' | 'failed';
  outputDir: string;
  imageCount: number;
  batchSize: number;
  customIds: string[]; // ['batch-0', 'batch-1', ...]
  fileOrder: string[]; // original filenames in submission order
}
```

## Error recovery

| Situation                                          | What to do                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `status: 'failed'`                                 | Delete `analysis_job.json`; re-run without `--async`                                        |
| `status: 'submitted'` but >24h old (OpenAI)        | Job may have expired; re-submit                                                             |
| `status: 'submitted'` but >29 days old (Anthropic) | Results deleted; re-submit                                                                  |
| Partial results in cache                           | Check for `.analysis_cache_partial.json`; use `--skip-analysis` to process completed images |

## Implementation notes

- `src/analyzer/async-batch.ts` owns `submitAsyncBatch()` and `resumeAsyncBatch()`
- `AsyncBatchClient` interface is defined in `src/analyzer/client.ts`
- `createAsyncBatchClient(config)` factory in `client.ts` returns the correct implementation per provider
- Always call `migrateCache()` from `src/utils/migrate.ts` when reading any cached `AnalysisCache`
