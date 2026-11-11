/**
 * Tests for the spec-003 benchmark gate (US4 / FR-006, SC-003).
 *
 * The gate is the thing that keeps a later change from quietly degrading the
 * product, so its boundary behaviour is pinned precisely: exactly at the
 * tolerance passes, a hair beyond it fails, and a partial run never fails.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_REVIEW_THRESHOLD,
  DEFAULT_GATE_TOLERANCE,
  evaluateGate,
  findBaselineEntry,
  readBaselineFile,
  writeBaselineFile,
  type BaselineEntry,
  type BaselineFile,
} from '../../src/benchmark/gate.js';
import {
  scoreMetrics,
  type GoldItem,
  type MetricsResult,
  type PredictionItem,
} from '../../src/benchmark/metrics.js';

/**
 * A gold set of `size` items over two classes.
 *
 * `correctCount` of them are predicted correctly, which gives a macro F1 the
 * gate can reason about.
 */
function buildRun(correctCount: number, size = 10): {
  metrics: ReturnType<typeof scoreMetrics>;
  gold: GoldItem[];
  predictions: PredictionItem[];
} {
  const gold: GoldItem[] = [];
  const predictions: PredictionItem[] = [];
  for (let index = 0; index < size; index += 1) {
    const labelKey = index % 2 === 0 ? 'alpha' : 'beta';
    const id = `item-${String(index).padStart(3, '0')}`;
    gold.push({ id, labelKey });
    const correct = index < correctCount;
    predictions.push({
      id,
      labelKey: correct ? labelKey : index % 2 === 0 ? 'beta' : 'alpha',
      probability: correct ? 0.9 : 0.1,
    });
  }
  return { metrics: scoreMetrics(gold, predictions), gold, predictions };
}

function baselineEntry(macroF1: number, perClass: Record<string, number>): BaselineEntry {
  return {
    suite: 'synthetic',
    model: 'demo',
    macroF1,
    perClass,
    balancedAccuracy: macroF1,
    ece: 0,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('evaluateGate', () => {
  let dir: string;
  let baselinePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-'));
    baselinePath = path.join(dir, 'synthetic.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips when no baseline is recorded', () => {
    const { metrics } = buildRun(8);
    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
    });

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.reason).toMatch(/no baseline/i);
  });

  it('passes when the macro F1 did not move', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [baselineEntry(metrics.macroF1, { alpha: 0.8, beta: 0.8 })],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
    });

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.macroF1Delta).toBeCloseTo(0, 12);
  });

  it('fails when the macro F1 drops beyond the tolerance and names the regressed classes', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [baselineEntry(1, { alpha: 1, beta: 1 })],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
    });

    expect(result.passed).toBe(false);
    expect(result.macroF1Delta).toBeLessThan(DEFAULT_GATE_TOLERANCE);
    expect(result.regressedClasses.length).toBeGreaterThan(0);
    expect(result.reason).toMatch(/regressed classes/i);
    // The deltas are pinned values, not the definition restated: the baseline
    // recorded alpha=1 and beta=1, and the current run scores 0.8 for both.
    expect(result.deltas).toEqual([
      { labelKey: 'alpha', baseline: 1, current: 0.8000000000000002, delta: -0.19999999999999984 },
      { labelKey: 'beta', baseline: 1, current: 0.8000000000000002, delta: -0.19999999999999984 },
    ]);
    expect(result.macroF1Delta).toBeCloseTo(-0.2, 12);
  });

  it('fails when a class DISAPPEARS from the current metrics', () => {
    // The dangerous case: the current run scores only one class, so its plain
    // macro F1 is HIGHER than the baseline's. Comparing the plain means
    // would pass the gate while the vanished class collapsed to 0.
    const baselineEntry: BaselineEntry = {
      suite: 'synthetic',
      model: 'demo',
      macroF1: 0.9,
      perClass: { alpha: 0.9, beta: 0.9 },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [baselineEntry],
    });

    const current = {
      itemsScored: 5,
      correct: 5,
      accuracy: 1,
      perClass: [
        {
          labelKey: 'alpha',
          support: 5,
          predicted: 5,
          truePositives: 5,
          falsePositives: 0,
          falseNegatives: 0,
          precision: 1,
          recall: 1,
          f1: 1,
        },
      ],
      macroF1: 1,
      balancedAccuracy: 1,
      confusion: { labels: ['alpha'], rows: { alpha: { alpha: 5 } } },
      unseenPredictedLabels: [],
      excludedClasses: [],
      caveats: [],
      latency: { count: 0, p50Ms: 0, p95Ms: 0 },
      cost: {
        totalCostUsd: 0,
        costPerImageUsd: 0,
        amortizedCostPerScoredImageUsd: 0,
        itemsWithCost: 0,
        itemsWithoutCost: 5,
      },
    } as unknown as MetricsResult;

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics: current,
      baselinePath,
    });

    // The vanished class must drag the comparison down, not raise it.
    expect(result.passed).toBe(false);
    expect(result.regressedClasses).toContain('beta');
    expect(result.reason).toMatch(/class set changed/i);
  });

  it('passes exactly at the tolerance and fails a hair beyond it', () => {
    const { metrics } = buildRun(8);
    // The baseline sits 0.02 ABOVE the current run, so the delta is exactly
    // −0.02 — the tolerance boundary. The comparison runs over the UNION of
    // the class sets, so the baseline's per-class values are what matter.
    const baselinePerClass: Record<string, number> = {};
    for (const entry of metrics.perClass) {
      baselinePerClass[entry.labelKey] = entry.f1 + 0.02;
    }

    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [baselineEntry(metrics.macroF1 + 0.02, baselinePerClass)],
    });

    const atTolerance = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      tolerance: -0.02,
    });
    expect(atTolerance.macroF1Delta).toBeCloseTo(-0.02, 12);
    expect(atTolerance.passed).toBe(true);

    const beyond = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      tolerance: -0.02 + 1e-6,
    });
    expect(beyond.passed).toBe(false);
  });

  it('skips a partial run instead of failing it', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [baselineEntry(1, {})],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      partial: true,
      baselinePath,
    });

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.reason).toMatch(/partial/i);
  });

  it('detects a planted regression and names the regressed classes', () => {
    // The baseline is a perfect run; the current run flips a tenth of the
    // predictions, which is the scenario the spec describes.
    const perfect = buildRun(10);
    const regressed = buildRun(9);

    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        baselineEntry(perfect.metrics.macroF1, {
          alpha: perfect.metrics.perClass.find((c) => c.labelKey === 'alpha')?.f1 ?? 0,
          beta: perfect.metrics.perClass.find((c) => c.labelKey === 'beta')?.f1 ?? 0,
        }),
      ],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics: regressed.metrics,
      baselinePath,
    });

    expect(result.passed).toBe(false);
    expect(result.regressedClasses).toContain('alpha');
  });

  it('updates the baseline with a dated header', () => {
    const { metrics } = buildRun(8);
    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      updateBaseline: true,
      now: new Date('2026-03-04T05:06:07.000Z'),
    });

    expect(result.updated).toBe(true);
    expect(existsSync(baselinePath)).toBe(true);

    const file = readBaselineFile(baselinePath) as BaselineFile;
    expect(file.generatedAt).toBe('2026-03-04T05:06:07.000Z');
    const entry = findBaselineEntry(file, 'synthetic', 'demo');
    expect(entry).toBeDefined();
    expect(entry?.macroF1).toBe(metrics.macroF1);
    expect(entry?.generatedAt).toBe('2026-03-04T05:06:07.000Z');
  });

  it('refuses a baseline update larger than the review threshold without force', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [baselineEntry(metrics.macroF1 + BASELINE_REVIEW_THRESHOLD + 0.01, {})],
    });

    expect(() =>
      evaluateGate({
        suite: 'synthetic',
        model: 'demo',
        metrics,
        baselinePath,
        updateBaseline: true,
      }),
    ).toThrow(/refusing to update the baseline/i);
  });

  it('allows a large baseline update when force is given', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [baselineEntry(metrics.macroF1 + BASELINE_REVIEW_THRESHOLD + 0.01, {})],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      updateBaseline: true,
      force: true,
    });

    expect(result.updated).toBe(true);
    const file = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile;
    const entry = findBaselineEntry(file, 'synthetic', 'demo');
    expect(entry?.macroF1).toBe(metrics.macroF1);
  });

  it('writes a readable baseline file', () => {
    const { metrics } = buildRun(8);
    evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      updateBaseline: true,
    });

    const raw = readFileSync(baselinePath, 'utf8');
    expect(raw).toContain('\n  "schemaVersion"');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('the baseline is keyed by (suite, model, model version)', () => {
  let dir: string;
  let baselinePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-version-'));
    baselinePath = path.join(dir, 'synthetic.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not reuse a baseline recorded for a DIFFERENT model version', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          suite: 'synthetic',
          model: 'demo',
          modelVersion: 'model:demo@1.0.0',
          macroF1: 1,
          perClass: { alpha: 1, beta: 1 },
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    // The run is of model:demo@2.0.0 — a DIFFERENT model.
    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      modelVersion: 'model:demo@2.0.0',
      metrics,
      baselinePath,
    });

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.reason).toMatch(/no baseline/i);
  });

  it('compares against the baseline of the SAME model version', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          suite: 'synthetic',
          model: 'demo',
          modelVersion: 'model:demo@2.0.0',
          macroF1: 1,
          perClass: { alpha: 1, beta: 1 },
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      modelVersion: 'model:demo@2.0.0',
      metrics,
      baselinePath,
    });

    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.regressedClasses.length).toBeGreaterThan(0);
  });

  it('records the model version when it writes a baseline', () => {
    const { metrics } = buildRun(8);
    evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      modelVersion: 'model:demo@3.0.0',
      metrics,
      baselinePath,
      updateBaseline: true,
    });

    const file = readBaselineFile(baselinePath) as BaselineFile;
    const entry = findBaselineEntry(file, 'synthetic', 'demo', 'model:demo@3.0.0');
    expect(entry).toBeDefined();
    expect(entry?.modelVersion).toBe('model:demo@3.0.0');
  });
});
