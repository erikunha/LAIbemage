import { describe, expect, it, vi } from 'vitest';
import { runHybridBatch } from '../../src/analyzer/router.js';
import type { LLMClient } from '../../src/analyzer/client.js';
import type { Config } from '../../src/config/index.js';
import type { FileWithStats } from '../../src/types.js';

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('mock-jpeg')),
  })),
}));

// Mock createCloudClientForHybrid so it returns our controlled mock
vi.mock('../../src/analyzer/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analyzer/client.js')>();
  return {
    ...actual,
    createCloudClientForHybrid: vi.fn(() => ({
      complete: cloudComplete,
    })),
  };
});

const cloudComplete = vi.fn();

function makeFile(name: string, index: number): FileWithStats {
  return { file: name, fullPath: `/input/${name}`, createdAt: index * 1000, exifSource: 'ctime' };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    provider: 'hybrid',
    model: 'llava',
    localModel: 'llava',
    cloudProvider: 'openai',
    localConfidenceThreshold: 0.7,
    batchSize: 5,
    maxRetries: 1,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
    asyncBatch: false,
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
    linkImages: false,
    linkWindowDays: 7,
    selfCritique: false,
    learn: false,
    embed: false,
    serveLogRequests: false,
    ...overrides,
  } as Config;
}

function makeLocalClient(responses: { category: string; confidence: number }[]): LLMClient {
  let callIdx = 0;
  return {
    complete: vi.fn(() => {
      const batch = responses.slice(callIdx, callIdx + 5);
      callIdx += batch.length;
      return Promise.resolve({
        text: JSON.stringify({
          images: batch.map((r, i) => ({
            index: i + 1,
            category: r.category,
            shortDescription: 'test',
            elements: [],
            confidence: r.confidence,
            extractedText: '',
          })),
        }),
        tokensUsed: 10,
        inputTokens: 8,
        outputTokens: 2,
      });
    }),
  };
}

describe('runHybridBatch', () => {
  it('returns all local results when all confidence above threshold', async () => {
    const config = makeConfig({ localConfidenceThreshold: 0.6 });
    const files = [makeFile('a.jpg', 1), makeFile('b.jpg', 2)];
    const localClient = makeLocalClient([
      { category: 'kitchen', confidence: 0.9 },
      { category: 'bathroom', confidence: 0.8 },
    ]);

    const results = await runHybridBatch(files, config, localClient);

    expect(results).toHaveLength(2);
    expect(results[0]?.category).toBe('kitchen');
    expect(results[1]?.category).toBe('bathroom');
    expect(cloudComplete).not.toHaveBeenCalled();
  });

  it('escalates low-confidence image to cloud', async () => {
    const config = makeConfig({ localConfidenceThreshold: 0.7 });
    const files = [makeFile('low.jpg', 1)];
    const localClient = makeLocalClient([{ category: 'kitchen', confidence: 0.5 }]);
    cloudComplete.mockResolvedValueOnce({
      text: JSON.stringify({
        category: 'bathroom',
        shortDescription: 'white tiles',
        elements: [],
        confidence: 0.95,
        extractedText: '',
      }),
      tokensUsed: 5,
      inputTokens: 3,
      outputTokens: 2,
    });

    const results = await runHybridBatch(files, config, localClient);

    expect(results[0]?.category).toBe('bathroom');
    expect(results[0]?.confidence).toBe(0.95);
  });

  it('escalates unknown category to cloud', async () => {
    const config = makeConfig({ localConfidenceThreshold: 0.7 });
    const files = [makeFile('unk.jpg', 1)];
    const localClient = makeLocalClient([{ category: 'unknown', confidence: 0.8 }]);
    cloudComplete.mockResolvedValueOnce({
      text: JSON.stringify({
        category: 'kitchen',
        shortDescription: 'clean countertop',
        elements: [],
        confidence: 0.85,
        extractedText: '',
      }),
      tokensUsed: 5,
      inputTokens: 3,
      outputTokens: 2,
    });

    const results = await runHybridBatch(files, config, localClient);

    expect(results[0]?.category).toBe('kitchen');
  });
});
