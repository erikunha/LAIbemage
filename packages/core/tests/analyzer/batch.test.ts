import { describe, expect, it, vi } from 'vitest';
import { analyzeBatch, buildBatchPrompt, normalizeCategory } from '../../src/analyzer/batch.js';
import type { LLMClient } from '../../src/analyzer/client.js';
import type { Config } from '../../src/config/index.js';
import type { FileWithStats } from '../../src/types.js';

// Mock Sharp so tests don't need real JPEG files
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('mock-jpeg')),
  })),
}));

function makeConfig(): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      description: 'Test categories',
      categories: [
        { name: 'kitchen', description: 'Kitchen area' },
        { name: 'bathroom', description: 'Bathroom area' },
        { name: 'payment_receipt', description: 'Receipts' },
      ],
      pinnedLast: ['payment_receipt'],
      immune: ['payment_receipt'],
      overridable: ['unknown'],
      timezone: 'UTC',
    },
    apiKey: 'test-key',
    anthropicApiKey: '',
    googleApiKey: '',
    provider: 'openai',
    model: 'gpt-4o',
    batchSize: 5,
    maxRetries: 2,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
    outputFormat: 'json',
    verbose: false,
    quiet: false,
    // Use concurrency:1 (sequential) by default for deterministic test ordering
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

function makeClient(responseText: string, tokensUsed = 100): LLMClient {
  return {
    complete: vi
      .fn()
      .mockResolvedValue({ text: responseText, tokensUsed, inputTokens: 70, outputTokens: 30 }),
  };
}

describe('normalizeCategory', () => {
  it('lowercases and snake_cases the category', () => {
    expect(normalizeCategory('Living Room')).toBe('living_room');
    expect(normalizeCategory('Kitchen')).toBe('kitchen');
  });

  it('returns unknown for empty strings', () => {
    expect(normalizeCategory('')).toBe('unknown');
    expect(normalizeCategory('  ')).toBe('unknown');
  });

  it('strips leading/trailing underscores', () => {
    expect(normalizeCategory('_room_')).toBe('room');
  });

  it('collapses multiple separators', () => {
    expect(normalizeCategory('living--room')).toBe('living_room');
    expect(normalizeCategory('living  room')).toBe('living_room');
  });
});

describe('buildBatchPrompt', () => {
  it('includes the category names in the prompt', () => {
    const config = makeConfig();
    const prompt = buildBatchPrompt(config, 10, 1);
    expect(prompt).toContain('kitchen');
    expect(prompt).toContain('bathroom');
    expect(prompt).toContain('payment_receipt');
  });

  it('includes batch count and startIndex', () => {
    const config = makeConfig();
    const prompt = buildBatchPrompt(config, 5, 11);
    expect(prompt).toContain('5 images');
    expect(prompt).toContain('Image 11');
  });
});

describe('analyzeBatch', () => {
  it('returns one AnalysisResult per file on a successful single batch', async () => {
    const config = makeConfig();
    const files = [makeFile('a.jpg', 1), makeFile('b.jpg', 2)];
    const response = JSON.stringify({
      images: [
        {
          index: 1,
          category: 'kitchen',
          shortDescription: 'clean kitchen area',
          elements: ['sink'],
        },
        {
          index: 2,
          category: 'bathroom',
          shortDescription: 'tiled bathroom floor',
          elements: [],
        },
      ],
    });
    const client = makeClient(response);

    const results = await analyzeBatch(files, config, client);

    expect(results).toHaveLength(2);
    expect(results[0].category).toBe('kitchen');
    expect(results[1].category).toBe('bathroom');
  });

  it('calls onProgress after each batch', async () => {
    const config = makeConfig();
    const files = [makeFile('a.jpg', 1)];
    const response = JSON.stringify({
      images: [
        {
          index: 1,
          category: 'kitchen',
          shortDescription: 'test',
          elements: [],
        },
      ],
    });
    const onProgress = vi.fn();
    await analyzeBatch(files, config, makeClient(response), onProgress);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(1, 1, 100, 70, 30);
  });

  it('calls onBatchComplete after each batch', async () => {
    const config = makeConfig();
    const files = [makeFile('a.jpg', 1)];
    const response = JSON.stringify({
      images: [
        {
          index: 1,
          category: 'kitchen',
          shortDescription: 'test',
          elements: [],
        },
      ],
    });
    const onBatchComplete = vi.fn().mockResolvedValue(undefined);
    await analyzeBatch(files, config, makeClient(response), undefined, onBatchComplete);
    expect(onBatchComplete).toHaveBeenCalledOnce();
    expect(onBatchComplete).toHaveBeenCalledWith(
      1,
      expect.arrayContaining([expect.objectContaining({ category: 'kitchen' })]),
    );
  });

  it('pads with unknown when LLM returns fewer results than expected', async () => {
    const config = makeConfig();
    const files = [makeFile('a.jpg', 1), makeFile('b.jpg', 2), makeFile('c.jpg', 3)];
    const response = JSON.stringify({
      images: [
        {
          index: 1,
          category: 'kitchen',
          shortDescription: 'test',
          elements: [],
        },
      ],
    });
    const results = await analyzeBatch(files, config, makeClient(response));
    expect(results).toHaveLength(3);
    expect(results[0].category).toBe('kitchen');
    expect(results[1].category).toBe('unknown');
    expect(results[2].category).toBe('unknown');
  });

  it('returns unknown results on non-quota batch failure without throwing', async () => {
    const config = makeConfig();
    const files = [makeFile('a.jpg', 1), makeFile('b.jpg', 2)];
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('network timeout')),
    };
    const results = await analyzeBatch(files, config, client);
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.category).toBe('unknown'));
  });

  it('re-throws quota exceeded errors immediately', async () => {
    const config = makeConfig();
    const files = [makeFile('a.jpg', 1)];
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('QUOTA_EXCEEDED: credits exhausted')),
    };
    await expect(analyzeBatch(files, config, client)).rejects.toThrow('QUOTA_EXCEEDED');
  });

  it('processes multiple batches when files exceed batchSize', async () => {
    const config = { ...makeConfig(), batchSize: 2 };
    const files = [makeFile('a.jpg', 1), makeFile('b.jpg', 2), makeFile('c.jpg', 3)];
    const makeResponse = (start: number, count: number) =>
      JSON.stringify({
        images: Array.from({ length: count }, (_, i) => ({
          index: start + i,
          category: 'kitchen',
          shortDescription: 'test item',
          elements: [],
        })),
      });
    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          text: makeResponse(1, 2),
          tokensUsed: 50,
          inputTokens: 35,
          outputTokens: 15,
        })
        .mockResolvedValueOnce({
          text: makeResponse(3, 1),
          tokensUsed: 25,
          inputTokens: 18,
          outputTokens: 7,
        }),
    };
    const results = await analyzeBatch(files, config, client);
    expect(results).toHaveLength(3);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it('returns results in original batch order when running concurrently', async () => {
    // concurrency:2 means both batches start simultaneously;
    // results must still come back in file order (batch 0 first, batch 1 second)
    const config = { ...makeConfig(), batchSize: 1, concurrency: 2 };
    const files = [makeFile('first.jpg', 1), makeFile('second.jpg', 2)];

    const client: LLMClient = {
      complete: vi
        .fn()
        // Deliberately return batch-0 result after batch-1 resolves to stress ordering
        .mockImplementation(async (_prompt: string, imgs: { label: string }[]) => {
          const isFirst = imgs[0].label.includes('first.jpg');
          await new Promise<void>((res) => setTimeout(res, isFirst ? 20 : 0));
          return {
            text: JSON.stringify({
              images: [
                {
                  index: 1,
                  category: isFirst ? 'kitchen' : 'bathroom',
                  shortDescription: isFirst ? 'first image' : 'second image',
                  elements: [],
                },
              ],
            }),
            tokensUsed: 10,
            inputTokens: 7,
            outputTokens: 3,
          };
        }),
    };

    const results = await analyzeBatch(files, config, client);
    expect(results).toHaveLength(2);
    // Batch 1 (bathroom) resolves first, but results must be in original order
    expect(results[0].category).toBe('kitchen');
    expect(results[1].category).toBe('bathroom');
  });
});
