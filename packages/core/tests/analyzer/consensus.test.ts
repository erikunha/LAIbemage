import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runConsensus } from '../../src/analyzer/consensus.js';
import type { Config } from '../../src/config/index.js';
import type { AnalyzedImage, FileWithStats } from '../../src/types.js';

vi.mock('../../src/analyzer/index.js', () => ({
  analyzeImages: vi.fn(),
}));

import { analyzeImages } from '../../src/analyzer/index.js';
const mockAnalyzeImages = vi.mocked(analyzeImages);

function makeConfig(): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [
        { name: 'kitchen', description: 'Kitchen area' },
        { name: 'bedroom', description: 'Bedroom area' },
      ],
      pinnedLast: [],
      immune: [],
      overridable: [],
      timezone: 'UTC',
    },
    provider: 'openai',
    apiKey: 'test-key',
    anthropicApiKey: 'test-anthropic',
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
    serveLogRequests: false,
    embed: false,
  };
}

function makeFile(name: string): FileWithStats {
  return {
    file: name,
    fullPath: `/input/${name}`,
    createdAt: 0,
    exifSource: 'ctime',
  };
}

function makeAnalyzed(file: FileWithStats, category: string, confidence: number): AnalyzedImage {
  return {
    ...file,
    analysis: {
      category,
      shortDescription: `a ${category}`,
      elements: [],
      confidence,
      extractedText: null,
    },
  };
}

describe('runConsensus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls through to single analyzeImages when fewer than 2 valid providers', async () => {
    const files = [makeFile('a.jpg')];
    const analyzed = [makeAnalyzed(files[0]!, 'kitchen', 0.9)];
    mockAnalyzeImages.mockResolvedValue({ images: analyzed, overrideCount: 0 });

    const result = await runConsensus(files, makeConfig(), ['openai']);
    expect(mockAnalyzeImages).toHaveBeenCalledTimes(1);
    expect(result.lowConsensusFiles.size).toBe(0);
    expect(result.images[0]!.analysis.category).toBe('kitchen');
  });

  it('runs both providers in parallel and agrees on matching categories', async () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg')];
    const p1 = [makeAnalyzed(files[0]!, 'kitchen', 0.9), makeAnalyzed(files[1]!, 'bedroom', 0.8)];
    const p2 = [makeAnalyzed(files[0]!, 'kitchen', 0.7), makeAnalyzed(files[1]!, 'bedroom', 0.85)];
    mockAnalyzeImages
      .mockResolvedValueOnce({ images: p1, overrideCount: 0 })
      .mockResolvedValueOnce({ images: p2, overrideCount: 0 });

    const result = await runConsensus(files, makeConfig(), ['openai', 'anthropic']);
    expect(mockAnalyzeImages).toHaveBeenCalledTimes(2);
    expect(result.lowConsensusFiles.size).toBe(0);
    expect(result.images[0]!.analysis.category).toBe('kitchen');
    expect(result.images[1]!.analysis.category).toBe('bedroom');
  });

  it('flags disagreement and picks the higher-confidence result', async () => {
    const files = [makeFile('a.jpg')];
    const p1 = [makeAnalyzed(files[0]!, 'kitchen', 0.6)];
    const p2 = [makeAnalyzed(files[0]!, 'bedroom', 0.9)]; // higher confidence
    mockAnalyzeImages
      .mockResolvedValueOnce({ images: p1, overrideCount: 0 })
      .mockResolvedValueOnce({ images: p2, overrideCount: 0 });

    const result = await runConsensus(files, makeConfig(), ['openai', 'anthropic']);
    expect(result.lowConsensusFiles.has('a.jpg')).toBe(true);
    expect(result.images[0]!.analysis.category).toBe('bedroom'); // p2 wins
    expect(result.images[0]!.analysis.confidence).toBe(0.9);
  });

  it('picks p1 when p1 confidence >= p2 on disagreement', async () => {
    const files = [makeFile('a.jpg')];
    const p1 = [makeAnalyzed(files[0]!, 'kitchen', 0.9)];
    const p2 = [makeAnalyzed(files[0]!, 'bedroom', 0.7)];
    mockAnalyzeImages
      .mockResolvedValueOnce({ images: p1, overrideCount: 0 })
      .mockResolvedValueOnce({ images: p2, overrideCount: 0 });

    const result = await runConsensus(files, makeConfig(), ['openai', 'anthropic']);
    expect(result.lowConsensusFiles.has('a.jpg')).toBe(true);
    expect(result.images[0]!.analysis.category).toBe('kitchen'); // p1 wins
  });

  it('ignores unknown provider names', async () => {
    const files = [makeFile('a.jpg')];
    const analyzed = [makeAnalyzed(files[0]!, 'kitchen', 0.9)];
    mockAnalyzeImages.mockResolvedValue({ images: analyzed, overrideCount: 0 });

    await runConsensus(files, makeConfig(), ['openai', 'notaprovider']);
    // 'notaprovider' is filtered — only 1 valid → falls back to single call
    expect(mockAnalyzeImages).toHaveBeenCalledTimes(1);
  });
});
