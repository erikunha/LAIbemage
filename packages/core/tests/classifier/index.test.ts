import { describe, expect, it } from 'vitest';
import { classifyAndSort } from '../../src/classifier/index.js';
import type { Config } from '../../src/config/index.js';
import type { AnalyzedImage } from '../../src/types.js';

function makeConfig(): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [],
      pinnedLast: ['unknown', 'payment_receipt'],
      immune: ['payment_receipt'],
      overridable: ['unknown'],
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
    interactive: false,
    plugins: [],
    embed: false,
    serveLogRequests: false,
  } as Config;
}

function makeImg(file: string, category: string, createdAt: number): AnalyzedImage {
  return {
    file,
    fullPath: `/input/${file}`,
    createdAt,
    exifSource: 'ctime',
    analysis: {
      category,
      shortDescription: 'test',
      elements: [],
      confidence: 0,
      extractedText: null,
    },
  };
}

describe('classifyAndSort', () => {
  it('groups images by category', () => {
    const imgs = [
      makeImg('a.jpg', 'kitchen', 1000),
      makeImg('b.jpg', 'bathroom', 2000),
      makeImg('c.jpg', 'kitchen', 500),
    ];
    const result = classifyAndSort(imgs, makeConfig());
    expect(result.grouped['kitchen']).toHaveLength(2);
    expect(result.grouped['bathroom']).toHaveLength(1);
  });

  it('sorts images within each category by creation time ascending', () => {
    const imgs = [makeImg('later.jpg', 'kitchen', 2000), makeImg('earlier.jpg', 'kitchen', 1000)];
    const result = classifyAndSort(imgs, makeConfig());
    expect(result.grouped['kitchen'][0].file).toBe('earlier.jpg');
    expect(result.grouped['kitchen'][1].file).toBe('later.jpg');
  });

  it('places pinned categories last in sortedCategories', () => {
    const imgs = [
      makeImg('a.jpg', 'kitchen', 1000),
      makeImg('b.jpg', 'unknown', 2000),
      makeImg('c.jpg', 'bathroom', 3000),
    ];
    const result = classifyAndSort(imgs, makeConfig());
    const last = result.sortedCategories[result.sortedCategories.length - 1];
    expect(last).toBe('unknown');
  });

  it('sorts non-pinned categories alphabetically', () => {
    const imgs = [
      makeImg('a.jpg', 'kitchen', 1000),
      makeImg('b.jpg', 'bathroom', 2000),
      makeImg('c.jpg', 'exterior', 3000),
    ];
    const result = classifyAndSort(imgs, makeConfig());
    expect(result.sortedCategories).toEqual(['bathroom', 'exterior', 'kitchen']);
  });

  it('returns grouped and sortedCategories for a single category', () => {
    const imgs = [makeImg('a.jpg', 'bedroom', 1000)];
    const result = classifyAndSort(imgs, makeConfig());
    expect(Object.keys(result.grouped)).toEqual(['bedroom']);
    expect(result.sortedCategories).toEqual(['bedroom']);
  });
});
