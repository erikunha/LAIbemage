/**
 * The oracle suite of the evaluation scorecard (spec 022, SC-002).
 *
 * The committed fixture's expected values were computed by an INDEPENDENT
 * Python enumeration that shares no code with the TypeScript metric
 * modules. This test recomputes the macro F1, the per-class F1 and the ECE
 * by brute force AGAIN, over the fixture's own lists, and then requires the
 * scorecard to agree with both computations to 1e-9.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCalibration } from '../../src/benchmark/calibration.js';
import type { PredictionItem } from '../../src/benchmark/metrics.js';
import { computeManifestHash, type SplitManifest } from '../../src/benchmark/splits.js';
import {
  buildScorecard,
  SCORECARD_DEFAULT_MIN_SUPPORT,
  type BuildScorecardOptions,
} from '../../src/benchmark/scorecard.js';
import type { DatasetRegistryEntry } from '../../src/benchmark/registry.js';
import type { ReproductionTuple } from '../../src/benchmark/runner.js';

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'scorecard-oracle.json',
);

interface OracleFixture {
  readonly manifest: Omit<SplitManifest, 'manifestHash'>;
  readonly predictions: readonly PredictionItem[];
  readonly expected: {
    readonly supportRule: number;
    readonly partitionSizes: { readonly train: number; readonly val: number; readonly test: number };
    readonly macroF1: number;
    readonly balancedAccuracy: number;
    readonly accuracy: number;
    readonly perClassF1: Readonly<Record<string, number>>;
    readonly excludedClasses: readonly { readonly labelKey: string; readonly support: number }[];
    readonly ece: number;
    readonly calibrationN: number;
    readonly missingPredictions: number;
    readonly orphanPredictions: number;
  };
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as OracleFixture;
const manifest: SplitManifest = {
  ...fixture.manifest,
  manifestHash: computeManifestHash(fixture.manifest),
};

const TUPLE: ReproductionTuple = {
  snapshotId: 'oracle-snapshot-0001',
  splitFingerprint: manifest.manifestHash,
  modelVersion: 'model:oracle@1.0.0',
  configFingerprint: 'fp2:oracle00000001',
  env: { nodeVersion: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
};

const DATASET_ENTRY: DatasetRegistryEntry = {
  id: 'scorecard-oracle',
  title: 'Scorecard oracle fixture (synthetic)',
  usage: 'benchmark',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  commercialUse: true,
  source: 'https://example.test/oracle',
  resource: 'https://example.test/oracle.tar',
  version: 'oracle-1',
  archiveBytes: null,
  etag: null,
  parts: { selected: ['alpha', 'beta', 'gamma', 'delta'], rationale: 'the oracle strata' },
  sha256: null,
  sha256PinnedAt: null,
  attribution: 'Synthetic oracle fixture; no external data.',
  fetchedAt: null,
  notes: 'Synthetic fixture of the scorecard oracle suite.',
};

const NOW = new Date('2026-11-11T00:00:00.000Z');

function buildOptions(): BuildScorecardOptions {
  return {
    suite: 'scorecard-oracle',
    model: 'oracle-model',
    tuple: TUPLE,
    splitManifest: manifest,
    predictions: fixture.predictions,
    datasetEntry: DATASET_ENTRY,
    resamples: 200,
    now: NOW,
  };
}

// ---------------------------------------------------------------------------
// The independent brute-force enumeration (no metric module involved)
// ---------------------------------------------------------------------------

interface FlatItem {
  readonly gold: string;
  readonly predicted: string | null;
}

const goldOf = (assignment: { readonly class: string; readonly anomaly: string }): string =>
  assignment.anomaly === 'normal' ? 'normal' : `defect:${assignment.class}`;

function flatten(
  assignments: readonly { id: string; class: string; anomaly: string; split: string }[],
  predictions: readonly PredictionItem[],
): FlatItem[] {
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  return assignments.map((assignment) => {
    const prediction = byId.get(assignment.id);
    return { gold: goldOf(assignment), predicted: prediction === undefined ? null : prediction.labelKey };
  });
}

function bruteForcePerClass(items: readonly FlatItem[], minSupport: number) {
  const tallies = new Map<string, { gold: number; predicted: number; tp: number }>();
  const tallyOf = (label: string): { gold: number; predicted: number; tp: number } => {
    const existing = tallies.get(label);
    if (existing !== undefined) return existing;
    const fresh = { gold: 0, predicted: 0, tp: 0 };
    tallies.set(label, fresh);
    return fresh;
  };
  for (const item of items) {
    tallyOf(item.gold).gold += 1;
    if (item.predicted === null) continue;
    const predicted = tallyOf(item.predicted);
    predicted.predicted += 1;
    if (item.predicted === item.gold) predicted.tp += 1;
  }
  const rows: { label: string; f1: number; recall: number; fn: number }[] = [];
  const excluded: { label: string; support: number }[] = [];
  // The class set is the GOLD vocabulary (the pinned convention): an unseen
  // predicted label is an error column, never a class of its own.
  const goldVocabulary = [...tallies.entries()]
    .filter(([, tally]) => tally.gold > 0)
    .map(([label]) => label)
    .sort();
  for (const label of goldVocabulary) {
    const tally = tallies.get(label) as { gold: number; predicted: number; tp: number };
    if (tally.gold < minSupport) {
      excluded.push({ label, support: tally.gold });
      continue;
    }
    const precision = tally.predicted > 0 ? tally.tp / tally.predicted : 0;
    const recall = tally.gold > 0 ? tally.tp / tally.gold : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    rows.push({ label, f1, recall, fn: tally.gold - tally.tp });
  }
  const macroF1 = rows.length > 0 ? rows.reduce((sum, row) => sum + row.f1, 0) / rows.length : 0;
  const balanced =
    rows.length > 0 ? rows.reduce((sum, row) => sum + row.recall, 0) / rows.length : 0;
  return { rows, excluded, macroF1, balanced };
}

function bruteForceEce(
  assignments: readonly { id: string; class: string; anomaly: string }[],
  predictions: readonly PredictionItem[],
): { ece: number; n: number } {
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const binned: { probability: number; correct: boolean }[] = [];
  for (const assignment of assignments) {
    const prediction = byId.get(assignment.id);
    if (prediction === undefined || prediction.probability === undefined) continue;
    binned.push({ probability: prediction.probability, correct: prediction.labelKey === goldOf(assignment) });
  }
  const total = binned.length;
  let ece = 0;
  for (let index = 0; index < 10; index += 1) {
    const members = binned.filter(
      (item) => Math.min(9, Math.floor(item.probability * 10)) === index,
    );
    if (members.length === 0 || total === 0) continue;
    const count = members.length;
    const confidence = members.reduce((sum, item) => sum + item.probability, 0) / count;
    const accuracy = members.filter((item) => item.correct).length / count;
    ece += (count / total) * Math.abs(accuracy - confidence);
  }
  return { ece, n: total };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('the scorecard oracle fixture (SC-002)', () => {
  const assignments = fixture.manifest.assignments;
  const testAssignments = assignments.filter((assignment) => assignment.split === 'test');
  const valAssignments = assignments.filter((assignment) => assignment.split === 'val');
  const brute = bruteForcePerClass(
    flatten(testAssignments, fixture.predictions),
    fixture.expected.supportRule,
  );
  const bruteVal = bruteForceEce(valAssignments, fixture.predictions);

  it('the fixture partitions are the sizes the manifest claims', () => {
    const count = (split: string) => assignments.filter((a) => a.split === split).length;
    expect(count('train')).toBe(fixture.expected.partitionSizes.train);
    expect(count('val')).toBe(fixture.expected.partitionSizes.val);
    expect(count('test')).toBe(fixture.expected.partitionSizes.test);
  });

  it('the brute-force enumeration agrees with the fixture expected values', () => {
    // The oracle is only an oracle if the independent computation and the
    // committed expected values agree first.
    expect(brute.macroF1).toBeCloseTo(fixture.expected.macroF1, 9);
    expect(brute.balanced).toBeCloseTo(fixture.expected.balancedAccuracy, 9);
    for (const [label, f1] of Object.entries(fixture.expected.perClassF1)) {
      const row = brute.rows.find((candidate) => candidate.label === label);
      expect(row, `brute-force row for ${label}`).toBeDefined();
      expect(row?.f1).toBeCloseTo(f1, 9);
    }
    expect(
      brute.excluded.map((entry) => ({ labelKey: entry.label, support: entry.support })),
    ).toEqual(fixture.expected.excludedClasses);
    expect(bruteVal.ece).toBeCloseTo(fixture.expected.ece, 9);
    expect(bruteVal.n).toBe(fixture.expected.calibrationN);
  });

  it('the scorecard produces the oracle macro F1, balanced accuracy and accuracy (1e-9)', () => {
    const result = buildScorecard(buildOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const metric = (name: string): number => {
      const record = result.scorecard.metrics.find((entry) => entry.name === name);
      expect(record, `metric ${name}`).toBeDefined();
      return record?.value ?? Number.NaN;
    };

    expect(metric('macroF1')).toBeCloseTo(fixture.expected.macroF1, 9);
    expect(metric('macroF1')).toBeCloseTo(brute.macroF1, 9);
    expect(metric('balancedAccuracy')).toBeCloseTo(fixture.expected.balancedAccuracy, 9);
    expect(metric('balancedAccuracy')).toBeCloseTo(brute.balanced, 9);
    expect(metric('accuracy')).toBeCloseTo(fixture.expected.accuracy, 9);
  });

  it('the scorecard produces the oracle per-class F1 values (1e-9)', () => {
    const result = buildScorecard(buildOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scorecard.perClass.map((row) => row.labelKey)).toEqual(
      Object.keys(fixture.expected.perClassF1),
    );
    for (const row of result.scorecard.perClass) {
      expect(row.f1).toBeCloseTo(fixture.expected.perClassF1[row.labelKey] as number, 9);
      const bruteRow = brute.rows.find((candidate) => candidate.label === row.labelKey);
      expect(bruteRow).toBeDefined();
      expect(row.f1).toBeCloseTo(bruteRow?.f1 ?? Number.NaN, 9);
    }
  });

  it('a class below the support rule is excluded loudly, never silently', () => {
    const result = buildScorecard(buildOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scorecard.supportRule).toBe(SCORECARD_DEFAULT_MIN_SUPPORT);
    expect(result.scorecard.supportRule).toBe(fixture.expected.supportRule);
    for (const excluded of fixture.expected.excludedClasses) {
      expect(result.scorecard.perClass.find((row) => row.labelKey === excluded.labelKey)).toBeUndefined();
      const limitation = result.scorecard.limitations.find(
        (entry) => entry.includes(excluded.labelKey) && entry.includes(String(excluded.support)),
      );
      expect(limitation, `a limitation naming ${excluded.labelKey}`).toBeDefined();
    }
  });

  it('a missing prediction counts as a failure and reaches the caveats', () => {
    const result = buildScorecard(buildOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // defect:alpha loses one item to a missing prediction: FN is 3 (two
    // mispredictions plus the missing one), not 2.
    const alpha = result.scorecard.perClass.find((row) => row.labelKey === 'defect:alpha');
    expect(alpha?.falseNegatives).toBe(3);
    expect(result.scorecard.coverage.expected).toBe(fixture.expected.partitionSizes.test);
    expect(result.scorecard.coverage.missing).toBe(fixture.expected.missingPredictions);
    expect(result.scorecard.coverage.scored).toBe(
      fixture.expected.partitionSizes.test - fixture.expected.missingPredictions,
    );
    expect(
      result.scorecard.limitations.some((entry) => entry.includes('no prediction')),
    ).toBe(true);
  });

  it('an unseen predicted label gets its own confusion column and is scored as a miss', () => {
    const result = buildScorecard(buildOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scorecard.confusion.labels).toContain('defect:unknown');
    expect(
      result.scorecard.limitations.some((entry) => entry.includes('defect:unknown')),
    ).toBe(true);
  });

  it('the ECE equals the independently computed ECE of the val partition alone (1e-9)', () => {
    const result = buildScorecard(buildOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const calibration = result.scorecard.calibration;
    expect(calibration.partition).toBe('val');
    expect(calibration.n).toBe(fixture.expected.calibrationN);
    expect(calibration.ece).toBeCloseTo(fixture.expected.ece, 9);
    expect(calibration.ece).toBeCloseTo(bruteVal.ece, 9);
    expect(calibration.probabilitySource).toBe('raw_declared');

    // The shipped calibration function over the val partition alone must
    // agree: the test partition contributed nothing to the number.
    const valIds = new Set(valAssignments.map((assignment) => assignment.id));
    const valOnly = fixture.predictions.filter((prediction) => valIds.has(prediction.id));
    const valGold = valAssignments.map((assignment) => ({
      id: assignment.id,
      labelKey: goldOf(assignment),
    }));
    expect(computeCalibration(valGold, valOnly).ece).toBeCloseTo(calibration.ece, 9);
  });

  it('the calibration partition digest and the three-digest rule are recorded', () => {
    const result = buildScorecard(buildOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scorecard.calibration.partitionDigest).not.toBe(
      result.scorecard.testSplitFingerprint,
    );
    expect(result.scorecard.manifestSha256).toBe(manifest.manifestHash);
    expect(result.scorecard.testSplitFingerprint).not.toBe(result.scorecard.manifestSha256);
    expect(result.scorecard.testSplitFingerprint).not.toBe(manifest.partitionFingerprint);
  });

  it('a raw_declared probability source raises the ADR-008 limitation', () => {
    const result = buildScorecard(buildOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calibrationSourceLimited(result.scorecard.limitations)).toBe(true);
  });

  it('a calibrated probability carries the calibrator reference', () => {
    const result = buildScorecard({
      ...buildOptions(),
      probabilitySource: 'calibrated',
      calibratorRef: 'calibrator:isotonic@val-2026-11',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scorecard.calibration.probabilitySource).toBe('calibrated');
    expect(result.scorecard.calibration.calibratorRef).toBe('calibrator:isotonic@val-2026-11');
    expect(calibrationSourceLimited(result.scorecard.limitations)).toBe(false);
  });
});

function calibrationSourceLimited(limitations: readonly string[]): boolean {
  return limitations.some(
    (entry) => entry.includes('raw_declared') && entry.includes('declared confidence'),
  );
}
