import { describe, expect, it, vi } from 'vitest';
import { resumeAsyncBatch, submitAsyncBatch } from '../../src/analyzer/async-batch.js';
import type { AsyncBatchClient } from '../../src/analyzer/client.js';
import type { Config } from '../../src/config/index.js';
import type { AsyncJobState, FileWithStats } from '../../src/types.js';

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('mock-jpeg')),
  })),
}));

vi.mock('../../src/utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/retry.js')>();
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

function makeConfig(): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      description: 'Test',
      categories: [{ name: 'kitchen', description: 'Kitchen' }],
      pinnedLast: [],
      immune: [],
      overridable: [],
      timezone: 'UTC',
    },
    apiKey: 'test-key',
    anthropicApiKey: '',
    googleApiKey: '',
    provider: 'openai',
    model: 'gpt-4o',
    batchSize: 2,
    maxRetries: 1,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
    asyncBatch: true,
    resumeBatch: false,
    outputFormat: 'json',
    verbose: false,
    quiet: false,
    concurrency: 1,
    estimate: false,
    temporalWindowMinutes: 5,
    consensusThreshold: 0.6,
    dedupeThreshold: 0,
    logFormat: 'pretty',
    timing: false,
    filenameTemplate: '{n}. Photo of {category} dated {date}',
    watch: false,
    watchPoll: false,
    interactive: false,
    plugins: [],
    embed: false,
    serveLogRequests: false,
  } as Config;
}

function makeFile(name: string, index: number): FileWithStats {
  return { file: name, fullPath: `/input/${name}`, createdAt: index * 1000, exifSource: 'ctime' };
}

function makeJobState(overrides: Partial<AsyncJobState> = {}): AsyncJobState {
  return {
    jobId: 'batch_abc123',
    provider: 'openai',
    model: 'gpt-4o',
    submittedAt: '2024-01-15T10:00:00.000Z',
    status: 'submitted',
    outputDir: './output',
    imageCount: 2,
    batchSize: 2,
    customIds: ['batch-0'],
    fileOrder: ['a.jpg', 'b.jpg'],
    ...overrides,
  };
}

describe('submitAsyncBatch', () => {
  it('calls submitBatch with one group per batchSize', async () => {
    const config = makeConfig();
    const files = [makeFile('a.jpg', 1), makeFile('b.jpg', 2), makeFile('c.jpg', 3)];
    const submitBatch = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-1', customIds: ['batch-0', 'batch-1'] });
    const asyncClient: AsyncBatchClient = {
      submitBatch,
      checkStatus: vi.fn(),
      retrieveResults: vi.fn(),
    };

    const state = await submitAsyncBatch(files, config, asyncClient);

    expect(submitBatch).toHaveBeenCalledOnce();
    const calls = submitBatch.mock.calls[0][0] as { customId: string }[];
    expect(calls).toHaveLength(2); // ceil(3/2) = 2 groups
    expect(calls[0].customId).toBe('batch-0');
    expect(calls[1].customId).toBe('batch-1');
    expect(state.jobId).toBe('job-1');
    expect(state.imageCount).toBe(3);
    expect(state.fileOrder).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('records image count and file order in the returned state', async () => {
    const config = makeConfig();
    const files = [makeFile('x.jpg', 1), makeFile('y.jpg', 2)];
    const asyncClient: AsyncBatchClient = {
      submitBatch: vi.fn().mockResolvedValue({ jobId: 'job-42', customIds: ['batch-0'] }),
      checkStatus: vi.fn(),
      retrieveResults: vi.fn(),
    };

    const state = await submitAsyncBatch(files, config, asyncClient);

    expect(state.imageCount).toBe(2);
    expect(state.fileOrder).toEqual(['x.jpg', 'y.jpg']);
    expect(state.provider).toBe('openai');
  });
});

describe('resumeAsyncBatch', () => {
  it('polls until complete then returns parsed results in order', async () => {
    const state = makeJobState();
    const responseText = JSON.stringify({
      images: [
        {
          index: 1,
          category: 'kitchen',
          shortDescription: 'clean kitchen',
          elements: [],
          confidence: 0.95,
          extractedText: '',
        },
        {
          index: 2,
          category: 'bathroom',
          shortDescription: 'white tiles',
          elements: [],
          confidence: 0.88,
          extractedText: '',
        },
      ],
    });

    const asyncClient: AsyncBatchClient = {
      submitBatch: vi.fn(),
      checkStatus: vi.fn().mockResolvedValueOnce('pending').mockResolvedValueOnce('complete'),
      retrieveResults: vi
        .fn()
        .mockResolvedValue([{ customId: 'batch-0', text: responseText, status: 'success' }]),
    };

    const results = await resumeAsyncBatch(state, asyncClient);

    expect(results).toHaveLength(2);
    expect(results[0].category).toBe('kitchen');
    expect(results[0].confidence).toBe(0.95);
    expect(results[1].category).toBe('bathroom');
  });

  it('pads with unknown when a batch group fails', async () => {
    const state = makeJobState();
    const asyncClient: AsyncBatchClient = {
      submitBatch: vi.fn(),
      checkStatus: vi.fn().mockResolvedValue('complete'),
      retrieveResults: vi
        .fn()
        .mockResolvedValue([{ customId: 'batch-0', text: '{}', status: 'failed' }]),
    };

    const results = await resumeAsyncBatch(state, asyncClient);

    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.category).toBe('unknown'));
  });

  it('throws when job has failed status', async () => {
    const state = makeJobState();
    const asyncClient: AsyncBatchClient = {
      submitBatch: vi.fn(),
      checkStatus: vi.fn().mockResolvedValue('failed'),
      retrieveResults: vi.fn(),
    };

    await expect(resumeAsyncBatch(state, asyncClient)).rejects.toThrow('batch_abc123');
  });

  it('normalizes categories in results', async () => {
    const state = makeJobState({ imageCount: 1, customIds: ['batch-0'] });
    const asyncClient: AsyncBatchClient = {
      submitBatch: vi.fn(),
      checkStatus: vi.fn().mockResolvedValue('complete'),
      retrieveResults: vi.fn().mockResolvedValue([
        {
          customId: 'batch-0',
          text: JSON.stringify({
            images: [
              {
                index: 1,
                category: 'Living Room',
                shortDescription: 'test',
                elements: [],
                confidence: 0.9,
                extractedText: '',
              },
            ],
          }),
          status: 'success',
        },
      ]),
    };

    const results = await resumeAsyncBatch(state, asyncClient);

    expect(results[0].category).toBe('living_room');
  });
});
