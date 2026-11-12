/**
 * Wiring tests for the run pipeline (packages/core/src/index.ts).
 *
 * The pipeline hands two values across function boundaries that used to be
 * ambiguous:
 *  - the retry budget (config.maxRetries counts retries, every consumer of
 *    withRetry counts attempts)
 *  - the provider that served the run (it prices the progress bar and the
 *    summary)
 *
 * Both are asserted at the call site, so a regression in the wiring fails here
 * rather than showing up as a wrong cost or a short retry budget in a run.
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, LLMProvider } from '../src/config/index.js';
import { MemoryFileRepository } from '../src/fs/memory-adapter.js';
import { runBatch } from '../src/index.js';
import type { ImageLink, ProcessedResult } from '../src/types.js';
import { configureLogger } from '../src/utils/logger.js';
import type { RunSummary } from '../src/utils/progress.js';
import { FIXTURES_DIR } from './fixtures/index.js';

const { linkImagesMock, printSummaryTableMock, startProgressMock, updateProgressMock } = vi.hoisted(
  () => ({
    linkImagesMock: vi.fn(
      (
        _images: readonly ProcessedResult[],
        _client: unknown,
        _windowDays: number,
        _maxAttempts: number,
        _retryDelayMs: number,
      ) => new Map<number, ImageLink[]>(),
    ),
    printSummaryTableMock: vi.fn((_summary: RunSummary) => undefined),
    startProgressMock: vi.fn(
      (_total: number, _totalBatches: number, _provider?: LLMProvider) => undefined,
    ),
    updateProgressMock: vi.fn(
      (_processed: number, _batch: number, _inputTokens: number, _outputTokens?: number) =>
        undefined,
    ),
  }),
);

vi.mock('../src/analyzer/linker.js', () => ({ linkImages: linkImagesMock }));

vi.mock('../src/processor/index.js', () => ({
  processImage: vi.fn(async (_img: unknown, number: number) => ({ outputName: `${number}.jpg` })),
}));

vi.mock('../src/utils/progress.js', () => ({
  printSummaryTable: printSummaryTableMock,
  startProgress: startProgressMock,
  stopProgress: vi.fn(),
  updateProgress: updateProgressMock,
  setCostProvider: vi.fn(),
}));

// The LLM client is replaced by a stub that answers with a valid batch envelope,
// so the analysis path runs without touching a provider SDK.
const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(async (prompt: string) => {
    const match = /You will receive (\d+) images/.exec(prompt);
    const count = match ? Number(match[1]) : 1;
    const images = Array.from({ length: count }, (_, i) => ({
      index: i + 1,
      category: 'kitchen',
      shortDescription: 'a kitchen photo',
      fullDescription: 'a kitchen photo',
      elements: [],
      confidence: 0.9,
      extractedText: '',
    }));
    return {
      text: JSON.stringify({ images }),
      tokensUsed: 550,
      inputTokens: 500,
      outputTokens: 50,
    };
  }),
}));

vi.mock('../src/analyzer/client.js', () => ({
  createLLMClient: vi.fn(() => ({ complete: completeMock })),
  createAsyncBatchClient: vi.fn(() => null),
  createCloudClientForHybrid: vi.fn(() => ({ complete: completeMock })),
}));

/** Two real fixture images, one LLM batch. */
const FIXTURE_NAMES = ['red.jpg', 'green.jpg'];

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    inputDir: FIXTURES_DIR,
    outputDir: path.join(FIXTURES_DIR, '..', 'output'),
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
    model: 'gpt-4o',
    batchSize: 20,
    maxRetries: 3,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
    asyncBatch: false,
    resumeBatch: false,
    outputFormat: 'none',
    logFormat: 'pretty',
    verbose: false,
    quiet: true,
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
    linkImages: true,
    linkWindowDays: 7,
    selfCritique: false,
    learn: false,
    activeLearnQueue: false,
    localModel: 'llava',
    cloudProvider: 'openai',
    localConfidenceThreshold: 0.7,
    embed: false,
    ...overrides,
  };
}

/** Runs the pipeline over the fixture images with an in-memory file store. */
async function runPipeline(overrides: Partial<Config> = {}): Promise<void> {
  const config = makeConfig(overrides);
  const repo = new MemoryFileRepository();
  for (const name of FIXTURE_NAMES) {
    repo.seed(path.join(FIXTURES_DIR, name), 'fixture');
  }
  await runBatch(config, repo);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('runBatch linking pass retry budget', () => {
  beforeEach(() => {
    configureLogger({ quiet: true });
    linkImagesMock.mockClear();
    printSummaryTableMock.mockClear();
    startProgressMock.mockClear();
    updateProgressMock.mockClear();
  });

  it('gives the linking pass one attempt more than the configured retries', async () => {
    await runPipeline({ maxRetries: 3 });

    expect(linkImagesMock).toHaveBeenCalledTimes(1);
    // linkImages counts attempts, config.maxRetries counts retries.
    expect(linkImagesMock.mock.calls[0]![3]).toBe(4);
  });

  it('runs the linking pass once when no retries are configured', async () => {
    await runPipeline({ maxRetries: 0 });

    expect(linkImagesMock).toHaveBeenCalledTimes(1);
    expect(linkImagesMock.mock.calls[0]![3]).toBe(1);
  });

  it('runs the linking pass twice when one retry is configured', async () => {
    await runPipeline({ maxRetries: 1 });

    expect(linkImagesMock).toHaveBeenCalledTimes(1);
    expect(linkImagesMock.mock.calls[0]![3]).toBe(2);
  });
});

describe('runBatch provider and token wiring', () => {
  beforeEach(() => {
    configureLogger({ quiet: true });
    linkImagesMock.mockClear();
    printSummaryTableMock.mockClear();
    startProgressMock.mockClear();
    updateProgressMock.mockClear();
  });

  it('starts the progress bar with the provider that serves the run', async () => {
    await runPipeline({ provider: 'anthropic', anthropicApiKey: 'test-key' });

    expect(startProgressMock).toHaveBeenCalledWith(2, 1, 'anthropic');
  });

  it('reports the input and output token split to the progress bar', async () => {
    await runPipeline();

    // The provider reported 500 input and 50 output tokens for the batch.
    // The provider that served the batch comes with it, so a run served by
    // two providers is priced with the rate of each provider.
    expect(updateProgressMock).toHaveBeenCalledWith(2, 1, 500, 50, 'openai');
  });

  it('prices the run summary with the provider that serves the run', async () => {
    await runPipeline({ provider: 'anthropic', anthropicApiKey: 'test-key' });

    expect(printSummaryTableMock).toHaveBeenCalledTimes(1);
    const summary = printSummaryTableMock.mock.calls[0]![0];
    expect(summary.provider).toBe('anthropic');
  });

  it('passes the token split to the run summary', async () => {
    await runPipeline();

    expect(printSummaryTableMock).toHaveBeenCalledTimes(1);
    const summary = printSummaryTableMock.mock.calls[0]![0];
    expect(summary.tokensUsed).toBe(550);
    expect(summary.inputTokens).toBe(500);
    expect(summary.outputTokens).toBe(50);
  });
});
