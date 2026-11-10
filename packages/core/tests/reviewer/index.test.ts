import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config/index.js';
import type { AnalyzedImage } from '../../src/types.js';

// Mock @inquirer/select and @inquirer/input before importing the module under test
vi.mock('@inquirer/select', () => ({ default: vi.fn() }));
vi.mock('@inquirer/input', () => ({ default: vi.fn() }));

// Import mocks and module under test after vi.mock declarations
import input from '@inquirer/input';
import select from '@inquirer/select';
import { runInteractiveReview } from '../../src/reviewer/index.js';

const mockSelect = vi.mocked(select);
const mockInput = vi.mocked(input);

function makeConfig(categories: string[] = ['mold', 'damage', 'clean']): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: categories.map((name) => ({
        name,
        description: name,
        pinnedLast: false,
        immune: false,
        overridable: false,
      })),
      pinnedLast: [],
      immune: [],
      overridable: [],
      timezone: 'UTC',
    },
    apiKey: 'test',
    anthropicApiKey: '',
    googleApiKey: '',
    provider: 'openai',
    model: 'gpt-4o',
    batchSize: 20,
    maxRetries: 3,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
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
    interactive: true,
    plugins: [],
    embed: false,
    serveLogRequests: false,
  } as Config;
}

function makeImg(file: string, category: string): AnalyzedImage {
  return {
    file,
    fullPath: `/input/${file}`,
    createdAt: Date.now(),
    exifSource: 'ctime',
    analysis: {
      category,
      shortDescription: `A ${category} image`,
      elements: ['element1'],
      confidence: 0,
      extractedText: null,
    },
  };
}

describe('runInteractiveReview', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  function setTTY(value: boolean) {
    Object.defineProperty(process.stdin, 'isTTY', {
      value,
      configurable: true,
    });
  }

  it('returns all images unchanged when stdin is not a TTY', async () => {
    setTTY(false);
    const images = [makeImg('a.jpg', 'mold'), makeImg('b.jpg', 'damage')];
    const result = await runInteractiveReview(images, makeConfig());

    expect(result.images).toHaveLength(2);
    expect(result.overrides).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('passes images through unchanged when all are accepted', async () => {
    setTTY(true);
    const images = [makeImg('a.jpg', 'mold'), makeImg('b.jpg', 'damage')];
    mockSelect.mockResolvedValue('accept');

    const result = await runInteractiveReview(images, makeConfig());

    expect(result.images).toHaveLength(2);
    expect(result.images[0].analysis.category).toBe('mold');
    expect(result.images[1].analysis.category).toBe('damage');
    expect(result.overrides).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('records an override and updates category when user changes it', async () => {
    setTTY(true);
    const images = [makeImg('a.jpg', 'mold')];
    // First call: action prompt → change; second call: category picker → clean
    mockSelect.mockResolvedValueOnce('change').mockResolvedValueOnce('clean');

    const result = await runInteractiveReview(images, makeConfig());

    expect(result.images).toHaveLength(1);
    expect(result.images[0].analysis.category).toBe('clean');
    expect(result.overrides).toHaveLength(1);
    expect(result.overrides[0]).toEqual({
      file: 'a.jpg',
      originalCategory: 'mold',
      overriddenCategory: 'clean',
    });
    expect(result.skipped).toHaveLength(0);
  });

  it('does not record an override when the same category is re-selected', async () => {
    setTTY(true);
    const images = [makeImg('a.jpg', 'mold')];
    // User picks change but then selects the same category
    mockSelect.mockResolvedValueOnce('change').mockResolvedValueOnce('mold');

    const result = await runInteractiveReview(images, makeConfig());

    expect(result.images).toHaveLength(1);
    expect(result.images[0].analysis.category).toBe('mold');
    expect(result.overrides).toHaveLength(0);
  });

  it('removes skipped images from results', async () => {
    setTTY(true);
    const images = [makeImg('a.jpg', 'mold'), makeImg('b.jpg', 'damage')];
    // Skip first, accept second
    mockSelect.mockResolvedValueOnce('skip').mockResolvedValueOnce('accept');

    const result = await runInteractiveReview(images, makeConfig());

    expect(result.images).toHaveLength(1);
    expect(result.images[0].file).toBe('b.jpg');
    expect(result.skipped).toEqual(['a.jpg']);
    expect(result.overrides).toHaveLength(0);
  });

  it('keeps remaining images as-is when user quits mid-way', async () => {
    setTTY(true);
    const images = [
      makeImg('a.jpg', 'mold'),
      makeImg('b.jpg', 'damage'),
      makeImg('c.jpg', 'clean'),
    ];
    // Accept first, quit on second
    mockSelect.mockResolvedValueOnce('accept').mockResolvedValueOnce('quit');

    const result = await runInteractiveReview(images, makeConfig());

    // a (accepted) + b (quit trigger) + c (unreviewed kept) = 3
    expect(result.images).toHaveLength(3);
    expect(result.images.map((i) => i.file)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(result.overrides).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('uses custom input when user selects the custom sentinel', async () => {
    setTTY(true);
    const images = [makeImg('a.jpg', 'mold')];
    // Action → change; category picker → __custom__; input prompt → 'my_custom'
    mockSelect.mockResolvedValueOnce('change').mockResolvedValueOnce('__custom__');
    mockInput.mockResolvedValueOnce('my_custom');

    const result = await runInteractiveReview(images, makeConfig());

    expect(result.images[0].analysis.category).toBe('my_custom');
    expect(result.overrides[0].overriddenCategory).toBe('my_custom');
  });

  it('handles Ctrl-C in the action prompt by treating it as quit', async () => {
    setTTY(true);
    const images = [makeImg('a.jpg', 'mold'), makeImg('b.jpg', 'damage')];
    // First prompt throws (Ctrl-C)
    mockSelect.mockRejectedValueOnce(new Error('User force closed the prompt'));

    const result = await runInteractiveReview(images, makeConfig());

    // All images kept (quit path includes remaining)
    expect(result.images).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });
});
