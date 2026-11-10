import { describe, expect, it, vi } from 'vitest';
import { searchKeyword, searchSemantic } from '../../src/search/query.js';
import type { ProcessedResult } from '../../src/types.js';
import type { Config } from '../../src/config/index.js';

// Mock generateEmbeddings so searchSemantic doesn't call real APIs
vi.mock('../../src/analyzer/embeddings.js', () => ({
  generateEmbeddings: vi
    .fn()
    .mockResolvedValue([{ number: 0, file: '__query__', vector: [1, 0, 0] }]),
}));

// Mock node:fs/promises to serve fake analysis_results.json
const mockFiles = new Map<string, string>();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async (path: string) => {
      const content = mockFiles.get(path as string);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      mockFiles.set(path as string, content as string);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const content = mockFiles.get(from as string);
      if (content !== undefined) {
        mockFiles.set(to as string, content);
        mockFiles.delete(from as string);
      }
    }),
  };
});

function makeConfig(): Config {
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
    googleApiKey: '',
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
    filenameTemplate: '{n}. Photo of {category} dated {date}',
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
  };
}

function makeResult(number: number, overrides: Partial<ProcessedResult> = {}): ProcessedResult {
  return {
    number,
    originalFile: `img${number}.jpg`,
    outputFile: `${number}. img${number}.jpg`,
    category: 'kitchen',
    shortDescription: 'A clean kitchen with modern appliances',
    fullDescription: '',
    elements: ['sink', 'refrigerator', 'tiles'],
    confidence: 0.9,
    extractedText: null,
    timestamp: number * 1000,
    ...overrides,
  };
}

describe('searchKeyword', () => {
  const images: ProcessedResult[] = [
    makeResult(1, {
      shortDescription: 'A cracked wall in the hallway',
      elements: ['crack', 'plaster'],
    }),
    makeResult(2, {
      shortDescription: 'Clean kitchen countertop',
      elements: ['counter', 'sink'],
      extractedText: 'Use by 2025',
    }),
    makeResult(3, {
      shortDescription: 'Bathroom with mold growth',
      elements: ['tiles', 'shower'],
      extractedText: 'WARNING: mold detected',
    }),
    makeResult(4, {
      shortDescription: 'Empty living room',
      elements: ['sofa', 'window'],
    }),
    makeResult(5, {
      shortDescription: 'Crack in ceiling corner',
      elements: ['ceiling', 'crack'],
    }),
  ];

  it('finds matches in shortDescription (case-insensitive)', () => {
    const results = searchKeyword('CRACK', images, { topK: 10 });
    const numbers = results.map((r) => r.number);
    expect(numbers).toContain(1);
    expect(numbers).toContain(5);
  });

  it('finds matches in elements (case-insensitive)', () => {
    const results = searchKeyword('SINK', images, { topK: 10 });
    const numbers = results.map((r) => r.number);
    expect(numbers).toContain(2);
  });

  it('finds matches in extractedText (case-insensitive)', () => {
    const results = searchKeyword('mold', images, { topK: 10 });
    const numbers = results.map((r) => r.number);
    // img3 has "mold" in both shortDescription and extractedText
    expect(numbers).toContain(3);
  });

  it('returns empty array when no match', () => {
    const results = searchKeyword('xyznonexistent', images, { topK: 10 });
    expect(results).toHaveLength(0);
  });

  it('respects topK limit', () => {
    const results = searchKeyword('crack', images, { topK: 1 });
    expect(results).toHaveLength(1);
  });

  it('ranks by number of field matches descending', () => {
    // img3 matches in shortDescription ("mold") AND extractedText ("mold") — score 2
    // Create a scenario where one image matches more fields
    const testImages: ProcessedResult[] = [
      makeResult(10, {
        shortDescription: 'crack visible',
        elements: ['crack', 'wall'],
        extractedText: null,
      }),
      makeResult(11, {
        shortDescription: 'clean wall',
        elements: ['plaster'],
        extractedText: 'crack noted',
      }),
    ];
    // img10: shortDescription match (1) + elements match (1) = 2
    // img11: extractedText match (1) = 1
    const results = searchKeyword('crack', testImages, { topK: 10 });
    expect(results[0]?.number).toBe(10);
    expect(results[0]?.score).toBeGreaterThan(results[1]!.score);
  });

  it('returns correct SearchResult shape', () => {
    const results = searchKeyword('crack', images, { topK: 1 });
    expect(results[0]).toMatchObject({
      number: expect.any(Number),
      file: expect.any(String),
      outputFile: expect.any(String),
      category: expect.any(String),
      score: expect.any(Number),
      shortDescription: expect.any(String),
    });
  });

  it('handles images with null extractedText', () => {
    const nullTextImages: ProcessedResult[] = [
      makeResult(20, { extractedText: null, shortDescription: 'kitchen crack' }),
    ];
    const results = searchKeyword('crack', nullTextImages, { topK: 10 });
    expect(results).toHaveLength(1);
    expect(results[0]?.number).toBe(20);
  });

  it('finds matches in fullDescription (case-insensitive)', () => {
    const testImages: ProcessedResult[] = [
      makeResult(30, {
        shortDescription: 'empty room',
        fullDescription: 'Large television mounted on the wall with a gaming console below.',
      }),
      makeResult(31, { shortDescription: 'clean kitchen', fullDescription: '' }),
    ];
    const results = searchKeyword('television', testImages, { topK: 10 });
    expect(results).toHaveLength(1);
    expect(results[0]?.number).toBe(30);
  });

  it('includes fullDescription in score and result when matched', () => {
    const testImages: ProcessedResult[] = [
      makeResult(40, {
        shortDescription: 'room with tv',
        fullDescription: 'A large tv mounted on the wall.',
      }),
      makeResult(41, {
        shortDescription: 'tv on stand',
        fullDescription: '',
      }),
    ];
    // img40 matches shortDescription + fullDescription (score 2)
    // img41 matches only shortDescription (score 1)
    const results = searchKeyword('tv', testImages, { topK: 10 });
    expect(results[0]?.number).toBe(40);
    expect(results[0]?.score).toBeGreaterThan(results[1]!.score);
    expect(results[0]?.fullDescription).toBe('A large tv mounted on the wall.');
  });
});

describe('searchSemantic', () => {
  const outputDir = '/test/output';

  // Helpers to set up fake files in the mock FS
  function setCache(images: ProcessedResult[]): void {
    const cache = {
      schemaVersion: 1,
      processedDate: '2026-01-01T00:00:00.000Z',
      totalImages: images.length,
      categories: ['kitchen'],
      categoriesHash: 'abc123def456',
      images,
    };
    mockFiles.set(`${outputDir}/analysis_results.json`, JSON.stringify(cache));
  }

  function setIndex(entries: Array<{ number: number; file: string; vector: number[] }>): void {
    const dims = entries[0]?.vector.length ?? 3;
    const index = {
      schemaVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      embeddingModel: 'text-embedding-3-small',
      dimensions: dims,
      entries,
    };
    mockFiles.set(`${outputDir}/analysis_embeddings.index.json`, JSON.stringify(index));
  }

  it('throws when analysis_results.json is missing', async () => {
    mockFiles.clear();
    await expect(
      searchSemantic('query text', outputDir, makeConfig(), { topK: 5, minScore: 0 }),
    ).rejects.toThrow('analysis_results.json not found');
  });

  it('throws when embedding index is missing', async () => {
    mockFiles.clear();
    setCache([makeResult(1)]);
    await expect(
      searchSemantic('query text', outputDir, makeConfig(), { topK: 5, minScore: 0 }),
    ).rejects.toThrow('analysis_embeddings.index.json not found');
  });

  it('returns ranked results matching the query vector', async () => {
    mockFiles.clear();
    const img1 = makeResult(1, { category: 'kitchen', shortDescription: 'A kitchen' });
    const img2 = makeResult(2, { category: 'bathroom', shortDescription: 'A bathroom' });
    setCache([img1, img2]);
    // query vector from mock is [1,0,0]
    // entry 1 has [1,0,0] (exact match), entry 2 has [0,1,0] (orthogonal)
    setIndex([
      { number: 1, file: 'img1.jpg', vector: [1, 0, 0] },
      { number: 2, file: 'img2.jpg', vector: [0, 1, 0] },
    ]);

    const results = await searchSemantic('my query', outputDir, makeConfig(), {
      topK: 5,
      minScore: 0,
    });

    expect(results.length).toBeGreaterThan(0);
    // img1 should score higher (similarity to [1,0,0] query)
    expect(results[0]?.number).toBe(1);
  });

  it('respects minScore filter', async () => {
    mockFiles.clear();
    setCache([makeResult(1), makeResult(2)]);
    setIndex([
      { number: 1, file: 'img1.jpg', vector: [1, 0, 0] },
      { number: 2, file: 'img2.jpg', vector: [0, 1, 0] },
    ]);

    // With minScore 0.5, only img1 (exact match, score=1.0) should pass
    const results = await searchSemantic('my query', outputDir, makeConfig(), {
      topK: 5,
      minScore: 0.5,
    });
    expect(results.every((r) => r.score >= 0.5)).toBe(true);
    expect(results.some((r) => r.number === 1)).toBe(true);
  });

  it('returns correct SearchResult shape', async () => {
    mockFiles.clear();
    setCache([makeResult(1)]);
    setIndex([{ number: 1, file: 'img1.jpg', vector: [1, 0, 0] }]);

    const results = await searchSemantic('my query', outputDir, makeConfig(), {
      topK: 5,
      minScore: 0,
    });

    expect(results[0]).toMatchObject({
      number: 1,
      file: expect.any(String),
      outputFile: expect.any(String),
      category: expect.any(String),
      score: expect.any(Number),
      shortDescription: expect.any(String),
    });
  });
});
