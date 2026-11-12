/**
 * The interval suite of the evaluation scorecard (spec 022, SC-003, US3).
 *
 * The bootstrap must be reproducible byte for byte from the recorded seed
 * derivation, the method must follow the split's `groupBasis`, and the
 * interval must bracket the point estimate on the oracle fixture. The
 * generator is the repository's `mulberry32`; the determinism tests below
 * are what makes that claim observable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PredictionItem } from '../../src/benchmark/metrics.js';
import {
  generateSplitManifest,
  computeManifestHash,
  type SplitItem,
  type SplitManifest,
} from '../../src/benchmark/splits.js';
import {
  BOOTSTRAP_SEED_DERIVATION,
  buildScorecard,
  deriveBootstrapSeed,
  groupAwareBootstrap,
  SCORECARD_DEFAULT_RESAMPLES,
  SCORECARD_PROTOCOL_VERSION,
  stratifiedItemBootstrap,
  type BuildScorecardOptions,
  type Scorecard,
} from '../../src/benchmark/scorecard.js';
import type { DatasetRegistryEntry } from '../../src/benchmark/registry.js';
import type { ReproductionTuple } from '../../src/benchmark/runner.js';
import { joinGoldAndPredictions } from '../../src/benchmark/metrics.js';
import { labelKeyOf } from '../../src/benchmark/taxonomy.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const ORACLE = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, 'packages', 'core', 'tests', 'benchmark', 'fixtures', 'scorecard-oracle.json'),
    'utf8',
  ),
) as {
  readonly manifest: Omit<SplitManifest, 'manifestHash'>;
  readonly predictions: readonly PredictionItem[];
};

const ORACLE_MANIFEST: SplitManifest = {
  ...ORACLE.manifest,
  manifestHash: computeManifestHash(ORACLE.manifest),
};

const NOW = new Date('2026-11-11T00:00:00.000Z');

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
  parts: { selected: [], rationale: 'synthetic fixture' },
  sha256: null,
  sha256PinnedAt: null,
  attribution: 'Synthetic oracle fixture; no external data.',
  fetchedAt: null,
  notes: 'Synthetic fixture of the scorecard intervals suite.',
};

const TUPLE: ReproductionTuple = {
  snapshotId: 'oracle-snapshot-0001',
  splitFingerprint: ORACLE_MANIFEST.manifestHash,
  modelVersion: 'model:oracle@1.0.0',
  configFingerprint: 'fp2:oracle00000001',
  env: { nodeVersion: 'v24.0.0', platform: 'darwin' },
};

function oracleOptions(resamples = 200): BuildScorecardOptions {
  return {
    suite: 'scorecard-oracle',
    model: 'oracle-model',
    tuple: TUPLE,
    splitManifest: ORACLE_MANIFEST,
    predictions: ORACLE.predictions,
    datasetEntry: DATASET_ENTRY,
    resamples,
    now: NOW,
  };
}

function macroF1Of(scorecard: Scorecard): number {
  const record = scorecard.metrics.find((metric) => metric.name === 'macroF1');
  expect(record).toBeDefined();
  return record?.value ?? Number.NaN;
}

function macroIntervalOf(scorecard: Scorecard) {
  const record = scorecard.metrics.find((metric) => metric.name === 'macroF1');
  expect(record?.ci).toBeDefined();
  return record?.ci;
}

/** The scored items of the oracle test partition, through the shipped join. */
function oracleTestItems() {
  const gold = ORACLE.manifest.assignments
    .filter((assignment) => assignment.split === 'test')
    .map((assignment) => ({
      id: assignment.id,
      labelKey: labelKeyOf(assignment),
      split: assignment.split,
    }));
  const goldIds = new Set(gold.map((item) => item.id));
  const predictions = ORACLE.predictions
    .filter((prediction) => goldIds.has(prediction.id))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return joinGoldAndPredictions(gold, predictions).items;
}

// ---------------------------------------------------------------------------
// The stratified method (the tracked split's method)
// ---------------------------------------------------------------------------

describe('the stratified item bootstrap', () => {
  it('is reproducible byte for byte: the same seed twice yields identical intervals', () => {
    const items = oracleTestItems();
    const first = stratifiedItemBootstrap(items, { resamples: 300, seed: 1234, minSupport: 10 });
    const second = stratifiedItemBootstrap(items, { resamples: 300, seed: 1234, minSupport: 10 });
    expect(first).toEqual(second);
  });

  it('brackets the point estimate on the oracle fixture', () => {
    const items = oracleTestItems();
    const interval = stratifiedItemBootstrap(items, {
      resamples: 500,
      seed: deriveBootstrapSeed(SCORECARD_PROTOCOL_VERSION, 'oracle'),
      minSupport: 10,
    }).macroF1;
    expect(interval.lower).toBeLessThan(interval.upper);
  });

  it('two scorecards over the same inputs produce byte-identical intervals', () => {
    const first = buildScorecard(oracleOptions());
    const second = buildScorecard({ ...oracleOptions(), now: new Date('2026-11-12T00:00:00.000Z') });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.scorecard.metrics).toEqual(second.scorecard.metrics);
    expect(first.scorecard.perClass).toEqual(second.scorecard.perClass);
  });

  it('records the method, the unit, the resample count and the seed derivation', () => {
    const result = buildScorecard(oracleOptions(150));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const interval = macroIntervalOf(result.scorecard);
    expect(interval?.method).toBe('stratified-item-bootstrap');
    expect(interval?.unit).toBe('item');
    expect(interval?.resamples).toBe(150);
    expect(interval?.resamples).not.toBe(SCORECARD_DEFAULT_RESAMPLES);
    expect(interval?.seedDerivation).toBe(BOOTSTRAP_SEED_DERIVATION);

    // The seed is the recorded derivation applied to this partition.
    expect(interval?.seed).toBe(
      deriveBootstrapSeed(SCORECARD_PROTOCOL_VERSION, result.scorecard.testSplitFingerprint),
    );
  });

  it('the derived seed is stable for the same partition and different for another', () => {
    const seedA = deriveBootstrapSeed(SCORECARD_PROTOCOL_VERSION, 'digest-a');
    const seedAagain = deriveBootstrapSeed(SCORECARD_PROTOCOL_VERSION, 'digest-a');
    const seedB = deriveBootstrapSeed(SCORECARD_PROTOCOL_VERSION, 'digest-b');
    expect(seedA).toBe(seedAagain);
    expect(seedA).not.toBe(seedB);
  });

  it('the interval brackets the point estimate and every per-class row carries its interval', () => {
    const result = buildScorecard(oracleOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const interval = macroIntervalOf(result.scorecard);
    const point = macroF1Of(result.scorecard);
    expect(interval?.lower).toBeLessThanOrEqual(point);
    expect(point).toBeLessThanOrEqual(interval?.upper ?? Number.NaN);

    for (const row of result.scorecard.perClass) {
      expect(row.ci, `interval of ${row.labelKey}`).toBeDefined();
      expect(row.ci?.lower).toBeLessThanOrEqual(row.f1);
      expect(row.f1).toBeLessThanOrEqual(row.ci?.upper ?? Number.NaN);
      expect(row.ci?.method).toBe('stratified-item-bootstrap');
    }
  });

  it('the item-level limitation is stated when the stratified method is used', () => {
    const result = buildScorecard(oracleOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.scorecard.limitations.some(
        (entry) =>
          entry.includes('stratified-item-bootstrap') &&
          entry.includes('cannot prove acquisition-level independence'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The group-aware method
// ---------------------------------------------------------------------------

/** A small grouped manifest: 30 items in 10 capture groups of 3. */
function groupedManifest(): SplitManifest {
  const items: SplitItem[] = [];
  for (let index = 0; index < 30; index += 1) {
    const id = `item-${String(index).padStart(3, '0')}`;
    items.push({
      id,
      class: index % 2 === 0 ? 'alpha' : 'beta',
      anomaly: index % 3 === 0 ? 'normal' : 'anomalous',
      group: `capture-${String(Math.floor(index / 3)).padStart(2, '0')}`,
      sha256: `hash-${id}`,
      path: `${id}.jpg`,
    });
  }
  return generateSplitManifest({
    id: 'scorecard-grouped.gold',
    datasetId: 'scorecard-oracle',
    seed: 11,
    items,
    strategy: 'grouped',
  });
}

function groupedPredictions(manifest: SplitManifest): PredictionItem[] {
  return manifest.assignments.map((assignment, index) => ({
    id: assignment.id,
    labelKey: index % 5 === 0 ? 'defect:other' : labelKeyOf(assignment),
    probability: index % 5 === 0 ? 0.4 : 0.9,
    latencyMs: 700 + (index % 9) * 30,
    costUsd: 0.002,
  }));
}

describe('the group-aware bootstrap', () => {
  const manifest = groupedManifest();

  it('the synthetic grouped manifest really enforces capture groups', () => {
    expect(manifest.groupBasis?.captureGroupsEnforced).toBe(true);
    expect(
      manifest.assignments.filter((assignment) => assignment.split === 'test').length,
    ).toBeGreaterThan(0);
    expect(
      manifest.assignments.filter((assignment) => assignment.split === 'val').length,
    ).toBeGreaterThan(0);
  });

  it('is reproducible from the same seed and records the group count', () => {
    const items = oracleTestItems();
    const groups = new Map(items.map((item, index) => [item.id, `group-${index % 6}`]));
    const options = { resamples: 200, seed: 99, minSupport: 1 };
    const first = groupAwareBootstrap(items, groups, options);
    const second = groupAwareBootstrap(items, groups, options);
    expect(first).toEqual(second);
    expect(first.method).toBe('group-aware-bootstrap');
    expect(first.unit).toBe('capture-group');
    expect(first.groups).toBe(6);
  });

  it('the scorecard uses the group-aware method when the split enforces groups and a map is supplied', () => {
    const testAssignments = manifest.assignments.filter(
      (assignment) => assignment.split === 'test',
    );
    // Every item of one object class moves together: a real capture-level
    // resampling unit, not one group per item.
    const captureGroups = new Map(
      testAssignments.map((assignment) => [assignment.id, `capture-${assignment.class}`]),
    );
    const result = buildScorecard({
      suite: 'scorecard-grouped',
      model: 'oracle-model',
      tuple: {
        snapshotId: 'grouped-snapshot-0001',
        splitFingerprint: manifest.manifestHash,
        modelVersion: 'model:oracle@1.0.0',
        configFingerprint: 'fp2:oracle00000001',
        env: { nodeVersion: 'v24.0.0', platform: 'darwin' },
      },
      splitManifest: manifest,
      predictions: groupedPredictions(manifest),
      datasetEntry: DATASET_ENTRY,
      captureGroups,
      minSupport: 1,
      resamples: 150,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const interval = macroIntervalOf(result.scorecard);
    expect(interval?.method).toBe('group-aware-bootstrap');
    expect(interval?.unit).toBe('capture-group');
    expect(interval?.groups).toBe(new Set(captureGroups.values()).size);
    expect(interval?.groups).toBeGreaterThan(1);
    expect(result.scorecard.split.captureGroupsEnforced).toBe(true);
    const point = macroF1Of(result.scorecard);
    expect(interval?.lower).toBeLessThanOrEqual(point);
    expect(point).toBeLessThanOrEqual(interval?.upper ?? Number.NaN);
  });

  it('falls back to the item bootstrap with an explicit limitation when no map is supplied', () => {
    const result = buildScorecard({
      suite: 'scorecard-grouped',
      model: 'oracle-model',
      tuple: {
        snapshotId: 'grouped-snapshot-0001',
        splitFingerprint: manifest.manifestHash,
        modelVersion: 'model:oracle@1.0.0',
        configFingerprint: 'fp2:oracle00000001',
        env: { nodeVersion: 'v24.0.0', platform: 'darwin' },
      },
      splitManifest: manifest,
      predictions: groupedPredictions(manifest),
      datasetEntry: DATASET_ENTRY,
      minSupport: 1,
      resamples: 150,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(macroIntervalOf(result.scorecard)?.method).toBe('stratified-item-bootstrap');
    expect(
      result.scorecard.limitations.some((entry) => entry.includes('no capture-group map was supplied')),
    ).toBe(true);
  });
});
