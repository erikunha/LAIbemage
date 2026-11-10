import { describe, expect, it } from 'vitest';
import { applyTemporalConsensus } from '../../src/analyzer/temporal.js';
import type { Config } from '../../src/config/index.js';
import type { AnalyzedImage } from '../../src/types.js';

function makeConfig(immune: string[], overridable: string[]): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [],
      pinnedLast: [],
      immune,
      overridable,
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

function makeImg(file: string, category: string, offsetMs: number): AnalyzedImage {
  return {
    file,
    fullPath: `/input/${file}`,
    createdAt: offsetMs,
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

const BASE = new Date('2024-01-01T12:00:00Z').getTime();
const MIN = 60_000;

describe('applyTemporalConsensus', () => {
  it('does nothing with fewer than 2 images', () => {
    const img = makeImg('img1.jpg', 'unknown', BASE);
    const config = makeConfig(['payment_receipt'], ['unknown']);
    const result = applyTemporalConsensus([img], config);
    expect(result[0]?.analysis.category).toBe('unknown');
  });

  it('overrides unknown with majority category in same cluster', () => {
    const imgs = [
      makeImg('img1.jpg', 'kitchen', BASE),
      makeImg('img2.jpg', 'kitchen', BASE + 1 * MIN),
      makeImg('img3.jpg', 'kitchen', BASE + 2 * MIN),
      makeImg('img4.jpg', 'unknown', BASE + 3 * MIN),
    ];
    const config = makeConfig([], ['unknown']);
    const result = applyTemporalConsensus(imgs, config);
    expect(result[3]?.analysis.category).toBe('kitchen');
  });

  it('does NOT override immune categories', () => {
    const imgs = [
      makeImg('img1.jpg', 'kitchen', BASE),
      makeImg('img2.jpg', 'kitchen', BASE + 1 * MIN),
      makeImg('img3.jpg', 'kitchen', BASE + 2 * MIN),
      makeImg('receipt.jpg', 'payment_receipt', BASE + 3 * MIN),
    ];
    const config = makeConfig(['payment_receipt'], ['unknown']);
    const result = applyTemporalConsensus(imgs, config);
    expect(result[3]?.analysis.category).toBe('payment_receipt');
  });

  it('does not override when majority is below 60%', () => {
    // 2 kitchen vs 2 bathroom — 50% each, below 60% threshold
    const imgs = [
      makeImg('img1.jpg', 'kitchen', BASE),
      makeImg('img2.jpg', 'kitchen', BASE + 1 * MIN),
      makeImg('img3.jpg', 'bathroom', BASE + 2 * MIN),
      makeImg('img4.jpg', 'bathroom', BASE + 3 * MIN),
      makeImg('img5.jpg', 'unknown', BASE + 4 * MIN),
    ];
    const config = makeConfig([], ['unknown']);
    const result = applyTemporalConsensus(imgs, config);
    // No clear 60% majority, unknown should stay
    expect(result[4]?.analysis.category).toBe('unknown');
  });

  it('images outside 5-min window are in different clusters', () => {
    const imgs = [
      makeImg('img1.jpg', 'kitchen', BASE),
      makeImg('img2.jpg', 'kitchen', BASE + 1 * MIN),
      // gap > 5 min — new cluster
      makeImg('img3.jpg', 'bathroom', BASE + 20 * MIN),
      makeImg('img4.jpg', 'bathroom', BASE + 21 * MIN),
      makeImg('img5.jpg', 'unknown', BASE + 22 * MIN),
    ];
    const config = makeConfig([], ['unknown']);
    const result = applyTemporalConsensus(imgs, config);
    // img5 is in the bathroom cluster, should be overridden to bathroom
    expect(result[4]?.analysis.category).toBe('bathroom');
    // img1/img2 (kitchen cluster) should not be affected
    expect(result[0]?.analysis.category).toBe('kitchen');
  });

  it('uses custom temporalWindowMinutes from config', () => {
    // A 30-minute window means images 20 min apart stay in the same cluster
    const config: Config = { ...makeConfig([], ['unknown']), temporalWindowMinutes: 30 };
    const imgs = [
      makeImg('img1.jpg', 'kitchen', BASE),
      makeImg('img2.jpg', 'kitchen', BASE + 1 * MIN),
      // 20 min gap — within 30-min window, same cluster
      makeImg('img3.jpg', 'unknown', BASE + 20 * MIN),
    ];
    const result = applyTemporalConsensus(imgs, config);
    expect(result[2]?.analysis.category).toBe('kitchen');
  });

  it('uses custom consensusThreshold from config', () => {
    // 2 kitchen + 1 unknown = 3 eligible (non-immune). 2/3 ≈ 66.7%.
    // Default threshold 0.6: 66.7% >= 60% → overrides.
    // High threshold 0.9: 66.7% < 90% → does NOT override.
    const configDefault: Config = { ...makeConfig([], ['unknown']), consensusThreshold: 0.6 };
    const imgs1 = [
      makeImg('a1.jpg', 'kitchen', BASE),
      makeImg('a2.jpg', 'kitchen', BASE + 1 * MIN),
      makeImg('a3.jpg', 'unknown', BASE + 2 * MIN),
    ];
    const result1 = applyTemporalConsensus(imgs1, configDefault);
    expect(result1[2]?.analysis.category).toBe('kitchen');

    const configHigh: Config = { ...makeConfig([], ['unknown']), consensusThreshold: 0.9 };
    const imgs2 = [
      makeImg('b1.jpg', 'kitchen', BASE),
      makeImg('b2.jpg', 'kitchen', BASE + 1 * MIN),
      makeImg('b3.jpg', 'unknown', BASE + 2 * MIN),
    ];
    const result2 = applyTemporalConsensus(imgs2, configHigh);
    // 66.7% < 90% — threshold prevents override
    expect(result2[2]?.analysis.category).toBe('unknown');
  });

  it('does not override when majority is below threshold', () => {
    // 1 kitchen, 1 bedroom (both counted in votes since neither is overridable)
    // 1 unknown (overridable, counted in eligible but not in votes)
    // eligible = 3, kitchen votes = 1, ratio = 1/3 ≈ 33.3% < default 0.6 → no override
    const config = makeConfig([], ['unknown']);
    const imgs = [
      makeImg('img1.jpg', 'kitchen', BASE),
      makeImg('img2.jpg', 'bedroom', BASE + 1 * MIN),
      makeImg('img3.jpg', 'unknown', BASE + 2 * MIN),
    ];
    const result = applyTemporalConsensus(imgs, config);
    expect(result[2]?.analysis.category).toBe('unknown');
  });

  it('does not mutate original images array', () => {
    const imgs = [
      makeImg('img1.jpg', 'kitchen', BASE),
      makeImg('img2.jpg', 'kitchen', BASE + 1 * MIN),
      makeImg('img3.jpg', 'unknown', BASE + 2 * MIN),
    ];
    const config = makeConfig([], ['unknown']);
    applyTemporalConsensus(imgs, config);
    // Original imgs must be unchanged
    expect(imgs[2]?.analysis.category).toBe('unknown');
  });
});
