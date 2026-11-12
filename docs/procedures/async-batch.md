# Async batch submission

Covers submitting large image sets (hundreds to thousands) to a provider async batch API
without blocking the terminal, and resuming later to collect the results, including recovery of
a failed or stuck job (folded in from the former recover-async-job guide). Use it when batch
pricing or off-peak submission matters, or when a submitted job must be inspected or recovered.

## When to use

- Process a large image set without blocking the terminal
- Take advantage of provider batch pricing (OpenAI Batch API: 50% cost reduction)
- Submit during off-peak hours and collect results later
- A submitted job failed, expired or seems stuck

## Provider support matrix

| Provider    | Async API         | Notes                                           |
| ----------- | ----------------- | ----------------------------------------------- |
| `openai`    | Batch API (JSONL) | 50% cost reduction; 24h completion window       |
| `anthropic` | Message Batches   | Standard pricing; results available for 29 days |
| `google`    | Not supported     | Use synchronous mode                            |
| `azure`     | Not supported     | Use synchronous mode                            |
| `ollama`    | Not supported     | Local only; use synchronous mode                |

## Step 1: submit the batch

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

## Step 2: resume when complete

```bash
node dist/cli/index.js \
  --resume \
  --output ./output \
  --provider openai \
  --api-key $OPENAI_API_KEY
```

This reads `analysis_job.json`, polls the provider until the job is complete (checking every 30
seconds), retrieves results, then runs the full classify, process and export pipeline.

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

When inspecting a stuck job, read these fields first and report `jobId`, `provider`,
`submittedAt`, `status` and `imageCount`, plus how long ago it was submitted; the age decides
the recovery path.

## Error recovery

| Situation                                          | What to do                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `status: 'failed'`                                 | Delete `analysis_job.json`; re-run without `--async`                                        |
| `status: 'submitted'` but >24h old (OpenAI)        | Job may have expired; delete `analysis_job.json` and re-submit with `--async`               |
| `status: 'submitted'` but >29 days old (Anthropic) | Results deleted; delete `analysis_job.json` and re-submit                                   |
| `status: 'submitted'`, recently submitted          | May still be processing; resume with `--resume`                                             |
| Partial results in cache                           | Check for `.analysis_cache_partial.json`; use `--skip-analysis` to process completed images |

After recovery, report what was recovered, how many images were processed and whether any
images were lost (the verification snippet in [recover-partial-run.md](./recover-partial-run.md)
covers it).

## Implementation notes

- `packages/core/src/analyzer/async-batch.ts` owns `submitAsyncBatch()` and `resumeAsyncBatch()`
- The `AsyncBatchClient` interface (`submitBatch()`, `checkStatus()`, `retrieveResults()`) is
  defined in `packages/core/src/analyzer/client.ts`
- The `createAsyncBatchClient(config)` factory in `client.ts` returns the correct implementation
  per provider
- Always call `migrateCache()` from `packages/core/src/store/migrate.ts` when reading any cached
  `AnalysisCache`; never assume the schema version is current
