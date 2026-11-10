import { describe, expect, it } from 'vitest';
import { getSortedCategories, groupByCategory, isImmune } from '../../src/classifier/rules.js';
import type { Config } from '../../src/config/index.js';

function makeConfig(pinnedLast: string[], immune: string[]): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [],
      pinnedLast,
      immune,
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
    interactive: false,
    plugins: [],
    embed: false,
    serveLogRequests: false,
  } as Config;
}

function makeImages(categories: string[]) {
  return categories.map((cat, i) => ({
    file: `img${i}.jpg`,
    fullPath: `/input/img${i}.jpg`,
    createdAt: i * 1000,
    exifSource: 'ctime' as const,
    analysis: {
      category: cat,
      shortDescription: 'test',
      elements: [],
      confidence: 0,
      extractedText: null,
    },
  }));
}

describe('groupByCategory', () => {
  it('groups images by category', () => {
    const imgs = makeImages(['kitchen', 'bathroom', 'kitchen', 'bathroom', 'bedroom']);
    const grouped = groupByCategory(imgs);
    expect(grouped['kitchen']).toHaveLength(2);
    expect(grouped['bathroom']).toHaveLength(2);
    expect(grouped['bedroom']).toHaveLength(1);
  });
});

describe('getSortedCategories', () => {
  it('places pinned categories at the end', () => {
    const grouped = groupByCategory(
      makeImages(['kitchen', 'bedroom', 'unknown', 'payment_receipt']),
    );
    const config = makeConfig(['unknown', 'payment_receipt'], []);
    const sorted = getSortedCategories(grouped, config);
    expect(sorted[sorted.length - 2]).toBe('unknown');
    expect(sorted[sorted.length - 1]).toBe('payment_receipt');
    // Non-pinned are alphabetically first
    expect(sorted[0]).toBe('bedroom');
    expect(sorted[1]).toBe('kitchen');
  });

  it('only includes categories present in grouped', () => {
    // pinnedLast includes "unknown" but grouped doesn't have it
    const grouped = groupByCategory(makeImages(['kitchen', 'bathroom']));
    const config = makeConfig(['unknown', 'payment_receipt'], []);
    const sorted = getSortedCategories(grouped, config);
    expect(sorted).not.toContain('unknown');
    expect(sorted).not.toContain('payment_receipt');
  });

  it('sorts non-pinned categories alphabetically', () => {
    const grouped = groupByCategory(makeImages(['living_room', 'bedroom', 'exterior', 'kitchen']));
    const config = makeConfig([], []);
    const sorted = getSortedCategories(grouped, config);
    expect(sorted).toEqual(['bedroom', 'exterior', 'kitchen', 'living_room']);
  });
});

describe('isImmune', () => {
  it('returns true for immune categories', () => {
    const config = makeConfig([], ['payment_receipt', 'conversation_screenshot']);
    expect(isImmune('payment_receipt', config)).toBe(true);
    expect(isImmune('conversation_screenshot', config)).toBe(true);
  });

  it('returns false for non-immune categories', () => {
    const config = makeConfig([], ['payment_receipt']);
    expect(isImmune('kitchen', config)).toBe(false);
    expect(isImmune('unknown', config)).toBe(false);
  });
});
