/**
 * Tests for the spec-003 benchmark gate (US4 / FR-006, SC-003).
 *
 * The gate is the thing that keeps a later change from quietly degrading the
 * product, so its boundary behaviour is pinned precisely: exactly at the
 * tolerance passes, a hair beyond it fails, and a partial run never fails.
 */

import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_REVIEW_THRESHOLD,
  DEFAULT_GATE_TOLERANCE,
  evaluateGate,
  findBaselineEntry,
  findRetiredBaselineEntry,
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

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

/**
 * A split manifest the gate can read: the manifest hash (the identity of the
 * file) and the partition each assignment sits in.
 */
function writeSplitFile(file: string, manifestHash: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        id: path.basename(file, '.json'),
        datasetId: 'test-dataset',
        strategy: 'stratified',
        manifestHash,
        partitionFingerprint: manifestHash,
        assignments: [
          { id: 'a', split: 'train' },
          { id: 'b', split: 'val' },
          { id: 'c', split: 'test' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return file;
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

  it('records the reproduction tuple in the baseline — the tracked artifact must be attributable', () => {
    // The run report under `benchmarks/results/` is gitignored; the baseline
    // is the TRACKED artifact, so it has to name the snapshot, the split and
    // the config the number belongs to (ADR-008).
    const { metrics } = buildRun(8);
    evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      updateBaseline: true,
      attribution: {
        snapshotId: 'abc123',
        splitFingerprint: 'split-hash',
        configFingerprint: 'fp2:deadbeefdeadbeef',
      },
      now: new Date('2026-03-04T05:06:07.000Z'),
    });

    const file = readBaselineFile(baselinePath) as BaselineFile;
    const entry = findBaselineEntry(file, 'synthetic', 'demo');
    expect(entry?.snapshotId).toBe('abc123');
    expect(entry?.splitFingerprint).toBe('split-hash');
    expect(entry?.configFingerprint).toBe('fp2:deadbeefdeadbeef');
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

/* ------------------------------------------------------------------ *
 * The run itself must belong to the tracked split
 * ------------------------------------------------------------------ */

describe('the run under evaluation must be measured against the tracked split', () => {
  let dir: string;
  let baselinePath: string;
  let splitsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-run-split-'));
    baselinePath = path.join(dir, 'synthetic.json');
    splitsDir = path.join(dir, 'splits');
    writeSplitFile(path.join(splitsDir, 'tracked.gold.json'), 'hash-tracked');
    writeSplitFile(path.join(splitsDir, 'old.gold.json'), 'hash-old');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A baseline that WAS recorded against the tracked split. */
  function baselineOnTrackedSplit(): void {
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          suite: 'synthetic',
          model: 'demo',
          macroF1: 0.8,
          perClass: { alpha: 0.8, beta: 0.8 },
          splitFingerprint: 'hash-tracked',
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  }

  it('fails when the run was measured against ANOTHER split', () => {
    const { metrics } = buildRun(8);
    // The baseline is on the tracked split, so the ONLY thing that can refuse
    // this run is the run's own fingerprint.
    baselineOnTrackedSplit();

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      currentSplitPath: path.join(splitsDir, 'tracked.gold.json'),
      splitsDir,
      attribution: { splitFingerprint: 'hash-old' },
    });

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    // The message names BOTH fingerprints and BOTH split ids.
    expect(result.reason).toContain('hash-old');
    expect(result.reason).toContain('hash-tracked');
    expect(result.reason).toContain('old.gold');
    expect(result.reason).toContain('tracked.gold');
    // The macro F1 was NOT compared.
    expect(result.macroF1Delta).toBe(0);
    expect(result.deltas).toEqual([]);
    expect(result.regressedClasses).toEqual([]);
  });

  it('fails when the run cannot be attributed to a split at all', () => {
    const { metrics } = buildRun(8);
    baselineOnTrackedSplit();

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      currentSplitPath: path.join(splitsDir, 'tracked.gold.json'),
      splitsDir,
    });

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toMatch(/cannot be attributed/i);
    expect(result.macroF1Delta).toBe(0);
    expect(result.deltas).toEqual([]);
  });

  it('refuses to RECORD a baseline from a run measured against another split', () => {
    const { metrics } = buildRun(8);
    baselineOnTrackedSplit();

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      currentSplitPath: path.join(splitsDir, 'tracked.gold.json'),
      splitsDir,
      updateBaseline: true,
      attribution: { splitFingerprint: 'hash-old' },
    });

    expect(result.passed).toBe(false);
    expect(result.updated).toBeUndefined();
    // Nothing was written: the retirement evidence is not replaced by a
    // number measured on the wrong partition.
    const file = readBaselineFile(baselinePath) as BaselineFile;
    expect(file.entries).toHaveLength(1);
  });

  it('compares when the run WAS measured against the tracked split', () => {
    const { metrics } = buildRun(8);
    baselineOnTrackedSplit();

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      currentSplitPath: path.join(splitsDir, 'tracked.gold.json'),
      splitsDir,
      attribution: { splitFingerprint: 'hash-tracked' },
    });

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * A baseline that cannot be attributed to a split
 * ------------------------------------------------------------------ */

describe('a baseline that cannot be attributed to the tracked split', () => {
  let dir: string;
  let baselinePath: string;
  let splitsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-baseline-split-'));
    baselinePath = path.join(dir, 'synthetic.json');
    splitsDir = path.join(dir, 'splits');
    writeSplitFile(path.join(splitsDir, 'tracked.gold.json'), 'hash-tracked');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails when the tracked baseline carries NO split fingerprint', () => {
    const { metrics } = buildRun(8);
    // The baseline is perfect, so only the missing attribution can refuse it.
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          suite: 'synthetic',
          model: 'demo',
          macroF1: 1,
          perClass: { alpha: 1, beta: 1 },
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      currentSplitPath: path.join(splitsDir, 'tracked.gold.json'),
      splitsDir,
      attribution: { splitFingerprint: 'hash-tracked' },
    });

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toMatch(/no split fingerprint/i);
    // The macro F1 was NOT compared.
    expect(result.macroF1Delta).toBe(0);
    expect(result.deltas).toEqual([]);
  });

  it('fails when the tracked baseline was measured against a split that is not tracked', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          suite: 'synthetic',
          model: 'demo',
          macroF1: 1,
          perClass: { alpha: 1, beta: 1 },
          splitFingerprint: 'hash-nowhere',
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      currentSplitPath: path.join(splitsDir, 'tracked.gold.json'),
      splitsDir,
      attribution: { splitFingerprint: 'hash-tracked' },
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/not among the tracked splits/i);
    expect(result.macroF1Delta).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The retirement of a baseline
 * ------------------------------------------------------------------ */

describe('a retired baseline is evidence, never a comparison', () => {
  let dir: string;
  let baselinePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-retired-'));
    baselinePath = path.join(dir, 'synthetic.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const RETIRED_REASON =
    'measured on the degenerate all-train split: with zero held-out images the number is not a performance figure';

  function retiredEntry(): BaselineEntry {
    return {
      suite: 'synthetic',
      model: 'demo',
      macroF1: 0.99,
      perClass: { alpha: 0.99, beta: 0.99 },
      status: 'retired',
      retiredReason: RETIRED_REASON,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('skips a retired entry and quotes the recorded reason', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [retiredEntry()],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
    });

    // A retired number is skipped, never compared and never failed.
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.reason).toContain(RETIRED_REASON);
  });

  it('never removes or overwrites a retired entry when a new baseline is written', () => {
    const { metrics } = buildRun(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [retiredEntry()],
    });

    const result = evaluateGate({
      suite: 'synthetic',
      model: 'demo',
      metrics,
      baselinePath,
      updateBaseline: true,
      now: new Date('2026-03-04T05:06:07.000Z'),
    });

    expect(result.updated).toBe(true);

    const file = readBaselineFile(baselinePath) as BaselineFile;
    // The retired entry SURVIVES, with its status and its reason.
    const retired = findRetiredBaselineEntry(file, 'synthetic', 'demo');
    expect(retired).toBeDefined();
    expect(retired?.status).toBe('retired');
    expect(retired?.retiredReason).toBe(RETIRED_REASON);
    // And the new ACTIVE entry is added alongside it.
    expect(file.entries).toHaveLength(2);
    const active = findBaselineEntry(file, 'synthetic', 'demo');
    expect(active).toBeDefined();
    expect(active?.macroF1).toBe(metrics.macroF1);
    expect(active?.status).not.toBe('retired');
  });

  it('finds the ACTIVE entry when a retired one exists for the same key', () => {
    const file: BaselineFile = {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        retiredEntry(),
        {
          suite: 'synthetic',
          model: 'demo',
          macroF1: 0.42,
          perClass: { alpha: 0.42, beta: 0.42 },
          generatedAt: '2026-03-04T05:06:07.000Z',
        },
      ],
    };

    expect(findBaselineEntry(file, 'synthetic', 'demo')?.macroF1).toBe(0.42);
    expect(findRetiredBaselineEntry(file, 'synthetic', 'demo')?.macroF1).toBe(0.99);
  });
});

/* ------------------------------------------------------------------ *
 * The real VisA retirement, end to end
 * ------------------------------------------------------------------ */

describe('the retired VisA baseline survives a new baseline for the same key', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-visa-retired-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the retired entry intact and adds an active entry', () => {
    const repositoryBaseline = path.join(REPO_ROOT, 'benchmarks', 'baselines', 'visa-subset.json');
    const trackedSplit = path.join(
      REPO_ROOT,
      'benchmarks',
      'splits',
      'visa-subset.v2.gold.json',
    );
    const copy = path.join(dir, 'visa-subset.json');
    copyFileSync(repositoryBaseline, copy);

    const before = readBaselineFile(copy) as BaselineFile;
    const retiredBefore = findRetiredBaselineEntry(
      before,
      'visa-subset',
      'gpt-4o',
      'model:gpt-4o@2024-11-20',
    );
    expect(retiredBefore).toBeDefined();
    expect(retiredBefore?.status).toBe('retired');
    expect(retiredBefore?.retiredReason).toBeTruthy();

    const manifest = JSON.parse(readFileSync(trackedSplit, 'utf8')) as { manifestHash: string };
    const { metrics } = buildRun(8);

    const result = evaluateGate({
      suite: 'visa-subset',
      model: 'gpt-4o',
      modelVersion: 'model:gpt-4o@2024-11-20',
      metrics,
      baselinePath: copy,
      currentSplitPath: trackedSplit,
      splitsDir: path.dirname(trackedSplit),
      updateBaseline: true,
      attribution: { splitFingerprint: manifest.manifestHash },
      now: new Date('2026-03-04T05:06:07.000Z'),
    });

    expect(result.updated).toBe(true);

    const after = readBaselineFile(copy) as BaselineFile;
    // The retired entry is untouched: same status, same reason.
    const retiredAfter = findRetiredBaselineEntry(
      after,
      'visa-subset',
      'gpt-4o',
      'model:gpt-4o@2024-11-20',
    );
    expect(retiredAfter).toBeDefined();
    expect(retiredAfter?.status).toBe('retired');
    expect(retiredAfter?.retiredReason).toBe(retiredBefore?.retiredReason);
    // The new ACTIVE entry is there, next to the retired one.
    expect(after.entries.length).toBe(before.entries.length + 1);
    const active = findBaselineEntry(
      after,
      'visa-subset',
      'gpt-4o',
      'model:gpt-4o@2024-11-20',
    );
    expect(active).toBeDefined();
    expect(active?.status).not.toBe('retired');
    expect(active?.splitFingerprint).toBe(manifest.manifestHash);
  });
});
