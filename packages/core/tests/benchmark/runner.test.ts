/**
 * Tests for the spec-003 benchmark runner (US3 / FR-005, SC-004).
 *
 * The tests that matter here are the REFUSALS: a runner that emits an
 * unattributed report, or scores a tampered image set, is worse than a runner
 * that does not exist — because its numbers look trustworthy.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertReproductionTuple,
  BenchmarkIntegrityError,
  computeRunId,
  renderMarkdownReport,
  runBenchmark,
  type ReproductionTuple,
} from '../../src/benchmark/runner.js';
import { generateSplitManifest, type SplitItem } from '../../src/benchmark/splits.js';
import type { GoldItem, PredictionItem } from '../../src/benchmark/metrics.js';

const TUPLE: ReproductionTuple = {
  snapshotId: 'abc1234',
  splitFingerprint: 'split-hash-0001',
  modelVersion: 'model:demo@1.0.0',
  configFingerprint: 'config-hash-0001',
  env: { nodeVersion: 'v24.0.0', platform: 'darwin' },
};

function makeItems(count: number, prefix = 'img'): SplitItem[] {
  const items: SplitItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${String(index).padStart(3, '0')}`;
    items.push({
      id,
      class: `class-${index % 2}`,
      anomaly: index % 3 === 0 ? 'normal' : 'anomalous',
      group: `group-${index % 4}`,
      sha256: `hash-${id}`,
      path: `${prefix}/${id}.jpg`,
    });
  }
  return items;
}

function goldFrom(items: SplitItem[]): GoldItem[] {
  return items.map((item) => ({
    id: item.id,
    labelKey: item.anomaly === 'normal' ? 'normal' : `defect:${item.class}`,
  }));
}

/** Predictions that are correct for the first `correctCount` gold items. */
function predictionsFrom(gold: GoldItem[], correctCount: number): PredictionItem[] {
  return gold.map((item, index) => ({
    id: item.id,
    labelKey: index < correctCount ? item.labelKey : 'defect:wrong',
    probability: index < correctCount ? 0.9 : 0.2,
    latencyMs: 100 + index,
    costUsd: 0.001,
  }));
}

describe('assertReproductionTuple', () => {
  it('refuses an undefined tuple', () => {
    expect(() => assertReproductionTuple(undefined)).toThrow(/reproduction tuple/i);
  });

  it('names every missing field at once', () => {
    let message = '';
    try {
      assertReproductionTuple({ snapshotId: 'abc' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('splitFingerprint');
    expect(message).toContain('modelVersion');
    expect(message).toContain('configFingerprint');
    expect(message).toContain('env');
    expect(message).not.toContain('snapshotId,');
  });

  it('accepts a complete tuple', () => {
    expect(assertReproductionTuple(TUPLE)).toEqual(TUPLE);
  });
});

describe('computeRunId', () => {
  it('is deterministic for the same inputs', () => {
    expect(computeRunId(TUPLE, 'suite', 'model')).toBe(
      computeRunId(TUPLE, 'suite', 'model'),
    );
  });

  it('changes when the tuple changes', () => {
    const other = { ...TUPLE, modelVersion: 'model:demo@2.0.0' };
    expect(computeRunId(TUPLE, 'suite', 'model')).not.toBe(
      computeRunId(other, 'suite', 'model'),
    );
  });
});

describe('runBenchmark', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(tmpdir(), 'vision-lens-runner-'));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('refuses to emit a report without a reproduction tuple and writes nothing', async () => {
    const items = makeItems(8);
    const gold = goldFrom(items);

    await expect(
      runBenchmark({
        suite: 'synthetic',
        model: 'demo',
        gold,
        predictions: predictionsFrom(gold, 6),
        tuple: undefined,
        outputDir,
      }),
    ).rejects.toThrow(/reproduction tuple/i);

    // Nothing was written — not even a run directory.
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it('emits a JSON artifact carrying the reproduction tuple', async () => {
    const items = makeItems(8);
    const gold = goldFrom(items);

    const result = await runBenchmark({
      suite: 'synthetic',
      model: 'demo',
      gold,
      predictions: predictionsFrom(gold, 6),
      tuple: TUPLE,
      minSamples: 1,
      outputDir,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(existsSync(result.reportJsonPath)).toBe(true);
    expect(existsSync(result.reportMarkdownPath)).toBe(true);

    const report = JSON.parse(readFileSync(result.reportJsonPath, 'utf8')) as {
      tuple: ReproductionTuple;
      runId: string;
      metrics: { macroF1: number };
      calibration: { ece: number };
    };
    expect(report.tuple).toEqual(TUPLE);
    expect(report.runId).toBe(result.runId);
    expect(report.metrics.macroF1).toBeGreaterThan(0);
    expect(report.calibration.ece).toBeGreaterThanOrEqual(0);
  });

  it('renders the same numbers in the Markdown artifact', async () => {
    const items = makeItems(8);
    const gold = goldFrom(items);

    const result = await runBenchmark({
      suite: 'synthetic',
      model: 'demo',
      gold,
      predictions: predictionsFrom(gold, 6),
      tuple: TUPLE,
      minSamples: 1,
      outputDir,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const markdown = readFileSync(result.reportMarkdownPath, 'utf8');
    const report = JSON.parse(readFileSync(result.reportJsonPath, 'utf8')) as {
      metrics: { macroF1: number; balancedAccuracy: number };
      calibration: { ece: number };
      tuple: ReproductionTuple;
    };

    expect(markdown).toContain(`Macro F1: **${report.metrics.macroF1.toFixed(4)}**`);
    expect(markdown).toContain(
      `Balanced accuracy: **${report.metrics.balancedAccuracy.toFixed(4)}**`,
    );
    expect(markdown).toContain(`Expected calibration error: **${report.calibration.ece.toFixed(4)}**`);
    expect(markdown).toContain(report.tuple.snapshotId);
    expect(markdown).toContain(report.tuple.splitFingerprint);
  });

  it('produces a byte-stable payload for identical inputs', async () => {
    const items = makeItems(8);
    const gold = goldFrom(items);
    const predictions = predictionsFrom(gold, 6);

    const first = await runBenchmark({
      suite: 'synthetic',
      model: 'demo',
      gold,
      predictions,
      tuple: TUPLE,
      minSamples: 1,
      outputDir: path.join(outputDir, 'a'),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = await runBenchmark({
      suite: 'synthetic',
      model: 'demo',
      gold,
      predictions,
      tuple: TUPLE,
      minSamples: 1,
      outputDir: path.join(outputDir, 'b'),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const strip = (file: string): string => {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      delete parsed['generatedAt'];
      return JSON.stringify(parsed);
    };

    expect(strip(first.reportJsonPath)).toBe(strip(second.reportJsonPath));
  });

  it('refuses to score a tampered split manifest', async () => {
    const items = makeItems(8);
    const manifest = generateSplitManifest({
      id: 'test.gold',
      datasetId: 'test',
      seed: 42,
      items,
    });
    // Tamper: the content no longer hashes to the hash it claims.
    const tampered = { ...manifest, seed: manifest.seed + 1 };

    await expect(
      runBenchmark({
        suite: 'synthetic',
        model: 'demo',
        gold: goldFrom(items),
        predictions: predictionsFrom(goldFrom(items), 6),
        tuple: TUPLE,
        minSamples: 1,
        splitManifest: tampered,
        outputDir,
      }),
    ).rejects.toThrow(BenchmarkIntegrityError);
  });

  it('refuses to score an image set whose hashes diverge from the manifest', async () => {
    const items = makeItems(8);
    const manifest = generateSplitManifest({
      id: 'test.gold',
      datasetId: 'test',
      seed: 42,
      items,
    });
    const gold = goldFrom(items);

    await expect(
      runBenchmark({
        suite: 'synthetic',
        model: 'demo',
        gold,
        predictions: predictionsFrom(gold, 6),
        tuple: TUPLE,
        minSamples: 1,
        splitManifest: manifest,
        assetHashes: { [gold[0]?.id ?? '']: 'a-different-hash' },
        outputDir,
      }),
    ).rejects.toThrow(/does not match the split manifest/i);
  });

  it('refuses to score a gold item the manifest does not know', async () => {
    const items = makeItems(8);
    const manifest = generateSplitManifest({
      id: 'test.gold',
      datasetId: 'test',
      seed: 42,
      items,
    });
    const gold = [...goldFrom(items), { id: 'stranger', labelKey: 'normal' }];

    await expect(
      runBenchmark({
        suite: 'synthetic',
        model: 'demo',
        gold,
        predictions: predictionsFrom(gold, 6),
        tuple: TUPLE,
        minSamples: 1,
        splitManifest: manifest,
        outputDir,
      }),
    ).rejects.toThrow(/not part of the split manifest/i);
  });

  it('records the partial-run caveat and marks the run partial', async () => {
    const items = makeItems(8);
    const gold = goldFrom(items);

    const result = await runBenchmark({
      suite: 'synthetic',
      model: 'demo',
      gold,
      predictions: predictionsFrom(gold, 6),
      tuple: TUPLE,
      minSamples: 1,
      partial: true,
      outputDir,
    });

    expect(result.partial).toBe(true);
    expect(result.caveats.join(' ')).toMatch(/PARTIAL/i);
  });
});

describe('renderMarkdownReport', () => {
  it('lists the caveats instead of hiding them', async () => {
    const report = {
      schemaVersion: 1,
      runId: 'run-1',
      suite: 'synthetic',
      model: 'demo',
      generatedAt: '2026-01-01T00:00:00.000Z',
      partial: false,
      tuple: TUPLE,
      minSamples: 1,
      metrics: {
        itemsScored: 8,
        correct: 6,
        accuracy: 0.75,
        perClass: [],
        macroF1: 0.5,
        balancedAccuracy: 0.5,
        confusion: { labels: [], rows: {} },
        unseenPredictedLabels: [],
        excludedClasses: [],
        caveats: [],
        latency: { count: 8, p50Ms: 100, p95Ms: 200 },
        cost: {
          totalCostUsd: 0.008,
          costPerImageUsd: 0.001,
          amortizedCostPerScoredImageUsd: 0.001,
          itemsWithCost: 8,
          itemsWithoutCost: 0,
        },
      },
      calibration: { itemsScored: 8, itemsWithoutProbability: 0, ece: 0.1, bins: [] },
      caveats: ['a caveat that must be visible'],
    };

    const markdown = renderMarkdownReport(report as never);
    expect(markdown).toContain('a caveat that must be visible');
    expect(markdown).toContain('## Caveats');
  });
});

describe('computePredictionDigest', () => {
  it('ignores the order of the predictions', async () => {
    const { computePredictionDigest } = await import('../../src/benchmark/runner.js');
    const a: PredictionItem[] = [
      { id: 'b', labelKey: 'x' },
      { id: 'a', labelKey: 'y' },
    ];
    const b: PredictionItem[] = [
      { id: 'a', labelKey: 'y' },
      { id: 'b', labelKey: 'x' },
    ];
    expect(computePredictionDigest(a)).toBe(computePredictionDigest(b));
  });

  it('changes when a prediction changes', async () => {
    const { computePredictionDigest } = await import('../../src/benchmark/runner.js');
    const a: PredictionItem[] = [{ id: 'a', labelKey: 'x' }];
    const b: PredictionItem[] = [{ id: 'a', labelKey: 'z' }];
    expect(computePredictionDigest(a)).not.toBe(computePredictionDigest(b));
  });
});

describe('the runner records what it could NOT verify', () => {
  it('reports the image bytes as unverified when no hashes are supplied', async () => {
    const items = makeItems(8);
    const manifest = generateSplitManifest({
      id: 'test.gold',
      datasetId: 'test',
      seed: 42,
      items,
    });
    const gold = goldFrom(items);

    const result = await runBenchmark({
      suite: 'synthetic',
      model: 'demo',
      gold,
      predictions: predictionsFrom(gold, 6),
      tuple: TUPLE,
      splitManifest: manifest,
      minSamples: 1,
      outputDir: path.join(tmpdir(), 'vision-lens-unverified'),
    });

    // The manifest hash WAS verified; the bytes behind the items were NOT.
    // A gate that silently skips the check it could not perform is worse
    // than no gate, so the fact is recorded in the report.
    expect(result.caveats.join(' ')).toMatch(/NOT verified/i);
  });

  it('records no such caveat when every hash was supplied and matched', async () => {
    const items = makeItems(8);
    const manifest = generateSplitManifest({
      id: 'test.gold',
      datasetId: 'test',
      seed: 42,
      items,
    });
    const gold = goldFrom(items);
    const assetHashes: Record<string, string> = {};
    for (const assignment of manifest.assignments) {
      assetHashes[assignment.id] = assignment.sha256;
    }

    const result = await runBenchmark({
      suite: 'synthetic',
      model: 'demo',
      gold,
      predictions: predictionsFrom(gold, 6),
      tuple: TUPLE,
      splitManifest: manifest,
      assetHashes,
      minSamples: 1,
      outputDir: path.join(tmpdir(), 'vision-lens-verified'),
    });

    expect(result.caveats.join(' ')).not.toMatch(/NOT verified/i);
  });
});
