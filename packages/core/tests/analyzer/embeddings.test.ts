import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config/index.js';
import type { ProcessedResult } from '../../src/types.js';

// Shared mock instances so tests can inspect calls
const mockCreate = vi.fn().mockResolvedValue({
  data: [{ embedding: [0.1, 0.2, 0.3] }],
});

const mockEmbedContent = vi.fn().mockResolvedValue({
  embedding: { values: [0.4, 0.5, 0.6] },
});

// Mock OpenAI — must be a class (constructor function) for `new OpenAI()` to work
vi.mock('openai', () => {
  function OpenAI() {
    return {
      embeddings: { create: mockCreate },
    };
  }
  return { default: OpenAI };
});

// Mock @google/generative-ai
vi.mock('@google/generative-ai', () => {
  function GoogleGenerativeAI() {
    return {
      getGenerativeModel: () => ({
        embedContent: mockEmbedContent,
      }),
    };
  }
  return { GoogleGenerativeAI };
});

const { generateEmbeddings } = await import('../../src/analyzer/embeddings.js');

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
    googleApiKey: 'google-test-key',
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
    activeLearnQueue: false,
    localModel: 'llava',
    cloudProvider: 'openai',
    localConfidenceThreshold: 0.7,
    embed: false,
    serveLogRequests: false,
    ...overrides,
  };
}

function makeResult(number: number, overrides: Partial<ProcessedResult> = {}): ProcessedResult {
  return {
    number,
    originalFile: `img${number}.jpg`,
    outputFile: `${number}. img${number}.jpg`,
    category: 'kitchen',
    shortDescription: 'A clean kitchen with modern appliances',
    elements: ['sink', 'refrigerator'],
    confidence: 0.9,
    extractedText: null,
    timestamp: number * 1000,
    ...overrides,
  };
}

describe('generateEmbeddings', () => {
  it('returns one EmbeddingEntry per ProcessedResult', async () => {
    const results = [makeResult(1), makeResult(2)];
    const entries = await generateEmbeddings(results, makeConfig());
    expect(entries).toHaveLength(2);
  });

  it('includes correct number and file in each entry', async () => {
    const results = [makeResult(3, { originalFile: 'photo3.jpg' })];
    const entries = await generateEmbeddings(results, makeConfig());
    expect(entries[0]?.number).toBe(3);
    expect(entries[0]?.file).toBe('photo3.jpg');
  });

  it('returns a vector array in each entry', async () => {
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, makeConfig());
    expect(Array.isArray(entries[0]?.vector)).toBe(true);
    expect(entries[0]?.vector.length).toBeGreaterThan(0);
  });

  it('uses google embedding for google provider', async () => {
    const config = makeConfig({ provider: 'google' });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    // Google mock returns [0.4, 0.5, 0.6]
    expect(entries[0]?.vector).toEqual([0.4, 0.5, 0.6]);
  });

  it('uses openai embedding for openai provider', async () => {
    const config = makeConfig({ provider: 'openai' });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    // OpenAI mock returns [0.1, 0.2, 0.3]
    expect(entries[0]?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('falls back to OpenAI for anthropic provider when apiKey is set', async () => {
    const config = makeConfig({ provider: 'anthropic', apiKey: 'fallback-key' });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    // Should succeed using OpenAI fallback — returns [0.1, 0.2, 0.3]
    expect(entries[0]?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws a clear error for anthropic provider when apiKey is empty', async () => {
    const config = makeConfig({ provider: 'anthropic', apiKey: '' });
    const results = [makeResult(1)];
    await expect(generateEmbeddings(results, config)).rejects.toThrow(
      'Anthropic/Bedrock provider does not support embeddings.',
    );
  });

  it('throws a clear error for bedrock provider when apiKey is empty', async () => {
    const config = makeConfig({ provider: 'bedrock', apiKey: '' });
    const results = [makeResult(1)];
    await expect(generateEmbeddings(results, config)).rejects.toThrow(
      'Anthropic/Bedrock provider does not support embeddings.',
    );
  });

  it('returns empty array for empty input', async () => {
    const entries = await generateEmbeddings([], makeConfig());
    expect(entries).toHaveLength(0);
  });

  it('builds correct embedding text combining category, shortDescription, and elements', async () => {
    mockCreate.mockClear();
    const result = makeResult(1, {
      category: 'bathroom',
      shortDescription: 'A tiled bathroom',
      elements: ['shower', 'basin'],
    });
    await generateEmbeddings([result], makeConfig({ provider: 'openai' }));

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0]?.[0] as { input: string } | undefined;
    expect(callArg?.input).toBe('bathroom: A tiled bathroom. Elements: shower, basin');
  });

  it('uses azure path (same as openai)', async () => {
    const config = makeConfig({ provider: 'azure', apiKey: 'azure-key' });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    expect(entries[0]?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('uses vertex path (same as google)', async () => {
    const config = makeConfig({ provider: 'vertex', googleApiKey: 'vertex-key' });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    expect(entries[0]?.vector).toEqual([0.4, 0.5, 0.6]);
  });

  it('uses ollama path via fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embedding: [0.7, 0.8, 0.9] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
    });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    expect(entries[0]?.vector).toEqual([0.7, 0.8, 0.9]);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0]![0] as string).toContain('/api/embeddings');

    vi.unstubAllGlobals();
  });

  it('throws when ollama returns non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    const config = makeConfig({ provider: 'ollama' });
    await expect(generateEmbeddings([makeResult(1)], config)).rejects.toThrow(
      '[embeddings] Ollama embedding request failed',
    );
    vi.unstubAllGlobals();
  });

  it('throws when ollama returns empty embedding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ embedding: [] }),
      }),
    );

    const config = makeConfig({ provider: 'ollama' });
    await expect(generateEmbeddings([makeResult(1)], config)).rejects.toThrow(
      '[embeddings] Ollama returned an empty embedding response.',
    );
    vi.unstubAllGlobals();
  });

  it('hybrid provider with openai cloud provider uses openai embeddings', async () => {
    const config = makeConfig({ provider: 'hybrid', cloudProvider: 'openai', apiKey: 'key' });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    expect(entries[0]?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('hybrid provider with google cloud provider uses google embeddings', async () => {
    const config = makeConfig({
      provider: 'hybrid',
      cloudProvider: 'google',
      googleApiKey: 'gkey',
    });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    expect(entries[0]?.vector).toEqual([0.4, 0.5, 0.6]);
  });

  it('hybrid provider with anthropic cloud provider falls back to openai when apiKey set', async () => {
    const config = makeConfig({ provider: 'hybrid', cloudProvider: 'anthropic', apiKey: 'key' });
    const results = [makeResult(1)];
    const entries = await generateEmbeddings(results, config);
    expect(entries[0]?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('hybrid provider with anthropic cloud provider throws when apiKey empty', async () => {
    const config = makeConfig({ provider: 'hybrid', cloudProvider: 'anthropic', apiKey: '' });
    const results = [makeResult(1)];
    await expect(generateEmbeddings(results, config)).rejects.toThrow(
      'Anthropic/Bedrock provider does not support embeddings.',
    );
  });
});
