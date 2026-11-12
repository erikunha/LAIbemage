/**
 * The scorecard suite (spec 022, SC-001, SC-004, SC-005, SC-007).
 *
 * The tests over the tracked split read the COMMITTED artifacts: the v2
 * split manifest, the frozen v1 manifest (the evidence of the degenerate
 * all-train split), the dataset registry and the retired baseline entry.
 * The refusal tests drive the builder with untrusted inputs and require the
 * typed error codes of the spec's vocabulary, never a thrown error and
 * never a zero-valued metric.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBaselineFile, type BaselineEntry, type BaselineFile } from '../../src/benchmark/gate.js';
import type { PredictionItem } from '../../src/benchmark/metrics.js';
import { findDataset, loadDatasetRegistry } from '../../src/benchmark/registry.js';
import {
  computeManifestHash,
  computePartitionFingerprint,
  type SplitManifest,
} from '../../src/benchmark/splits.js';
import {
  buildScorecard,
  checkScorecardBaseline,
  SCORECARD_DEFAULT_MIN_SUPPORT,
  SCORECARD_ERROR_CODES,
  SCORECARD_EVALUATED_PARTITION,
  SCORECARD_REGIME,
  selectPartition,
  serializeScorecard,
  WHOLE_SET_REGIME,
  type BuildScorecardOptions,
  type Scorecard,
} from '../../src/benchmark/scorecard.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const TRACKED_SPLIT = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'benchmarks', 'splits', 'visa-subset.v2.gold.json'), 'utf8'),
) as SplitManifest;

const FROZEN_V1_SPLIT = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'benchmarks', 'splits', 'visa-subset.gold.json'), 'utf8'),
) as SplitManifest;

const TRACKED_MANIFEST_HASH =
  '503c568463739a1522d675a474a219aecc918553315e0ec4e2800c2b10b21bb5';

const NOW = new Date('2026-11-11T00:00:00.000Z');
const NOW_LATER = new Date('2026-11-11T09:30:00.000Z');

/** Deterministic predictions over every assignment of a manifest. */
function predictionsOver(manifest: SplitManifest): PredictionItem[] {
  const vocabulary = [...new Set(manifest.assignments.map((a) => labelKey(a)))].sort();
  return manifest.assignments.flatMap((assignment, index) => {
    // A handful of test items carry no prediction at all: they must count
    // as failures, not as exclusions.
    if (assignment.split === 'test' && index % 31 === 0) return [];
    const gold = labelKey(assignment);
    const unseen = index % 59 === 0;
    const wrong = index % 17 === 0;
    const next = vocabulary[(vocabulary.indexOf(gold) + 1) % vocabulary.length] as string;
    return [
      {
        id: assignment.id,
        labelKey: unseen ? 'defect:not-in-vocabulary' : wrong ? next : gold,
        probability: wrong || unseen ? 0.4 : 0.9,
        latencyMs: 800 + (index % 7) * 50,
        ...(index % 3 === 0 ? {} : { costUsd: 0.0021 }),
      },
    ];
  });
}

function labelKey(assignment: { class: string; anomaly: string }): string {
  return assignment.anomaly === 'normal' ? 'normal' : `defect:${assignment.class}`;
}

async function trackedOptions(): Promise<BuildScorecardOptions> {
  const registry = await loadDatasetRegistry(path.join(REPO_ROOT, 'datasets', 'registry.json'));
  return {
    suite: 'visa-subset.v2',
    model: 'gpt-4o',
    tuple: {
      snapshotId: 'test-snapshot-0001',
      splitFingerprint: TRACKED_SPLIT.manifestHash,
      modelVersion: 'model:gpt-4o@2024-11-20',
      configFingerprint: 'fp2:3883e2f9a01107f8',
      env: { nodeVersion: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
    },
    splitManifest: TRACKED_SPLIT,
    predictions: predictionsOver(TRACKED_SPLIT),
    datasetEntry: findDataset(registry, 'visa-subset'),
    baselineFile: readBaselineFile(
      path.join(REPO_ROOT, 'benchmarks', 'baselines', 'visa-subset.json'),
    ),
    resamples: 100,
    now: NOW,
  };
}

// ---------------------------------------------------------------------------
// SC-001: the locked test partition, and nothing else
// ---------------------------------------------------------------------------

describe('the scorecard over the tracked split (SC-001)', () => {
  it(
    'scores exactly the 140 test assignments: n = 140, partition = test, no train or val item',
    async () => {
      const result = buildScorecard(await trackedOptions());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.scorecard.metrics.length).toBeGreaterThan(0);
      for (const metric of result.scorecard.metrics) {
        expect(metric.n, `metric ${metric.name}`).toBe(140);
        expect(metric.partition, `metric ${metric.name}`).toBe('test');
      }
      expect(result.scorecard.coverage.expected).toBe(140);
      expect(result.scorecard.split.counts).toEqual({ train: 420, val: 140, test: 140 });

      // The per-class support equals the test column of the manifest's
      // strata: 60 normal, 20 per defect class.
      const supportByLabel = new Map(result.scorecard.perClass.map((row) => [row.labelKey, row.support]));
      expect(supportByLabel.get('normal')).toBe(60);
      expect(supportByLabel.get('defect:candle')).toBe(20);
      expect(supportByLabel.get('defect:capsules')).toBe(20);
      expect(supportByLabel.get('defect:fryum')).toBe(20);
      expect(supportByLabel.get('defect:pcb1')).toBe(20);
      const supportSum = result.scorecard.perClass.reduce((sum, row) => sum + row.support, 0);
      expect(supportSum).toBe(140);
    },
    20000,
  );

  it('selectPartition never returns a train or val item for the test selection', () => {
    expect(SCORECARD_EVALUATED_PARTITION).toBe('test');
    const selection = selectPartition(TRACKED_SPLIT, SCORECARD_EVALUATED_PARTITION);
    expect(selection.known).toBe(true);
    expect(selection.assignments).toHaveLength(140);
    expect(selection.assignments.every((assignment) => assignment.split === 'test')).toBe(true);
    const train = selectPartition(TRACKED_SPLIT, 'train');
    const val = selectPartition(TRACKED_SPLIT, 'val');
    expect(train.assignments).toHaveLength(420);
    expect(val.assignments).toHaveLength(140);
  });

  it('the three split digests are recorded and never interchanged', async () => {
    const result = buildScorecard(await trackedOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const testAssignments = TRACKED_SPLIT.assignments.filter(
      (assignment) => assignment.split === 'test',
    );
    expect(result.scorecard.manifestSha256).toBe(TRACKED_MANIFEST_HASH);
    expect(result.scorecard.testSplitFingerprint).toBe(
      computePartitionFingerprint(testAssignments),
    );
    expect(result.scorecard.testSplitFingerprint).not.toBe(result.scorecard.manifestSha256);
    expect(result.scorecard.testSplitFingerprint).not.toBe(TRACKED_SPLIT.partitionFingerprint);
  });

  it('the support rule is explicit, recorded, and lower than the runner default', async () => {
    const result = buildScorecard(await trackedOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scorecard.supportRule).toBe(SCORECARD_DEFAULT_MIN_SUPPORT);
    expect(SCORECARD_DEFAULT_MIN_SUPPORT).toBeLessThan(30);
    // Every defect class (support 20) survives the rule.
    expect(result.scorecard.perClass).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// SC-004: attribution
// ---------------------------------------------------------------------------

describe('the scorecard carries its attribution (SC-004, FR-010, FR-011, FR-012)', () => {
  it(
    'carries the license, the model version, the device, the digests, the cost, the latency, the limitations and the tuple',
    async () => {
      const result = buildScorecard({
        ...(await trackedOptions()),
        device: { kind: 'mps', name: 'Apple M3 Pro', memoryGb: 36 },
        modelSizeBytes: 1_234_567_890,
        estimatedCost: { totalUsd: 0.294, rateAsOf: '2026-05-01' },
        latencyExtras: { coldMs: 1240, warmMs: 830, modelLoadMs: 5100 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const scorecard = result.scorecard;

      expect(scorecard.protocolVersion).toBe('scorecard-v1');
      expect(scorecard.schemaVersion).toBe(1);
      expect(scorecard.dataset.id).toBe('visa-subset');
      expect(scorecard.dataset.license).toBe('CC BY 4.0');
      expect(scorecard.dataset.licenseUrl).toBe('https://creativecommons.org/licenses/by/4.0/');
      expect(scorecard.modelVersion).toBe('model:gpt-4o@2024-11-20');
      expect(scorecard.configFingerprint).toBe('fp2:3883e2f9a01107f8');
      expect(scorecard.snapshotId).toBe('test-snapshot-0001');
      expect(scorecard.device).toEqual({ kind: 'mps', name: 'Apple M3 Pro', memoryGb: 36 });
      expect(scorecard.modelSize).toBe(1_234_567_890);
      expect(scorecard.cost.currency).toBe('USD');
      expect(scorecard.cost.measured).toBeDefined();
      expect(scorecard.cost.estimated).toEqual({
        totalUsd: 0.294,
        rateAsOf: '2026-05-01',
        source: 'packages/core/src/utils/cost.ts PROVIDER_PRICING',
      });
      expect(scorecard.cost.errorLoss).toBe('not_estimated');
      expect(scorecard.latency.count).toBeGreaterThan(0);
      expect(scorecard.latency.coldMs).toBe(1240);
      expect(scorecard.latency.warmMs).toBe(830);
      expect(scorecard.latency.modelLoadMs).toBe(5100);
      expect(scorecard.limitations.length).toBeGreaterThan(0);
      expect(scorecard.reproduction.splitFingerprint).toBe(TRACKED_MANIFEST_HASH);
      expect(scorecard.regime).toBe(SCORECARD_REGIME);
    },
    20000,
  );

  it('no metric is representable without a sample count and a partition', async () => {
    const result = buildScorecard(await trackedOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const metric of result.scorecard.metrics) {
      expect(typeof metric.value).toBe('number');
      expect(Number.isInteger(metric.n)).toBe(true);
      expect(metric.partition).toBe('test');
    }
    // The schema has no bare numeric accuracy field at the top level.
    expect('accuracy' in result.scorecard).toBe(false);
    expect('macroF1' in result.scorecard).toBe(false);
  });

  it('an unpriced item is counted, never treated as free', async () => {
    const result = buildScorecard(await trackedOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scorecard.cost.itemsWithCost + result.scorecard.cost.itemsWithoutCost).toBe(140);
    expect(result.scorecard.cost.itemsWithoutCost).toBeGreaterThan(0);
    expect(
      result.scorecard.limitations.some((entry) => entry.includes('carry no cost')),
    ).toBe(true);
  });

  it('an unnamed device and model size are recorded as unknown with a limitation', async () => {
    const result = buildScorecard(await trackedOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scorecard.device.kind).toBe('unknown');
    expect(result.scorecard.device.name).toBe('unknown');
    expect(result.scorecard.modelSize).toBe('unknown');
    expect(
      result.scorecard.limitations.some((entry) => entry.includes('device') && entry.includes('unknown')),
    ).toBe(true);
    expect(result.scorecard.limitations.some((entry) => entry.includes('model size'))).toBe(true);
  });

  it('the scorecard id is content-derived and stable across runs', async () => {
    const options = await trackedOptions();
    const first = buildScorecard(options);
    const second = buildScorecard({ ...options, now: NOW_LATER });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.scorecard.scorecardId).toBe(second.scorecard.scorecardId);
    expect(first.scorecard.scorecardId).toContain('visa-subset.v2-gpt-4o-sc-');
  });
});

// ---------------------------------------------------------------------------
// SC-003 (byte identity) - the intervals suite covers the interval half
// ---------------------------------------------------------------------------

describe('byte stability (SC-003)', () => {
  it(
    'two runs over the same inputs are byte-identical apart from generatedAt',
    async () => {
      const options = await trackedOptions();
      const first = buildScorecard(options);
      const second = buildScorecard({ ...options, now: NOW_LATER });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.scorecard.generatedAt).toBe(NOW.toISOString());
      expect(second.scorecard.generatedAt).toBe(NOW_LATER.toISOString());
      expect(serializeScorecard({ ...first.scorecard, generatedAt: '' })).toBe(
        serializeScorecard({ ...second.scorecard, generatedAt: '' }),
      );
    },
    20000,
  );
});

// ---------------------------------------------------------------------------
// SC-005: the refusals
// ---------------------------------------------------------------------------

describe('the refusals (SC-005, FR-003, FR-007, FR-017)', () => {
  it('the error vocabulary is exactly the spec set', () => {
    expect([...SCORECARD_ERROR_CODES]).toEqual([
      'test-partition-empty',
      'test-partition-missing',
      'calibration-partition-empty',
      'calibration-partition-is-test',
      'manifest-digest-mismatch',
      'prediction-set-invalid',
      'baseline-regime-mismatch',
      'artifact-write-failed',
    ]);
  });

  it('the test partition named as the calibration source is refused', async () => {
    const result = buildScorecard({
      ...(await trackedOptions()),
      calibrationPartition: 'test',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('calibration-partition-is-test');
    expect(result.error.message).toContain('test');
  });

  it('an empty selection is refused and emits no metric (the frozen v1 split)', async () => {
    const options = await trackedOptions();
    const result = buildScorecard({
      ...options,
      splitManifest: FROZEN_V1_SPLIT,
      tuple: { ...options.tuple, splitFingerprint: FROZEN_V1_SPLIT.manifestHash },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('test-partition-empty');
    expect(result.error.message).toContain('visa-subset.gold');
    // A failure carries no scorecard and no zero-valued metric.
    expect('scorecard' in result).toBe(false);
  });

  it('a partition name outside the vocabulary is refused as missing', () => {
    const selection = selectPartition(TRACKED_SPLIT, 'holdout');
    expect(selection.known).toBe(false);
    expect(selection.assignments).toHaveLength(0);
  });

  it('an empty calibration partition is refused', async () => {
    const options = await trackedOptions();
    const withoutVal = {
      ...TRACKED_SPLIT,
      assignments: TRACKED_SPLIT.assignments.filter((assignment) => assignment.split !== 'val'),
    };
    const noVal: SplitManifest = {
      ...withoutVal,
      manifestHash: computeManifestHash(withoutVal),
    };
    const result = buildScorecard({
      ...options,
      splitManifest: noVal,
      tuple: {
        ...options.tuple,
        splitFingerprint: noVal.manifestHash,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('calibration-partition-empty');
  });

  it('a tampered manifest is refused before any metric exists', async () => {
    const options = await trackedOptions();
    const tampered: SplitManifest = {
      ...TRACKED_SPLIT,
      assignments: TRACKED_SPLIT.assignments.map((assignment, index) =>
        index === 0 ? { ...assignment, sha256: '0'.repeat(64) } : assignment,
      ),
    };
    const result = buildScorecard({
      ...options,
      splitManifest: tampered,
      tuple: { ...options.tuple, splitFingerprint: tampered.manifestHash },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('manifest-digest-mismatch');
    expect(result.error.message).toContain('integrity');
  });

  it('a reproduction tuple that names another split is refused', async () => {
    const options = await trackedOptions();
    const result = buildScorecard({
      ...options,
      tuple: { ...options.tuple, splitFingerprint: 'deadbeef'.repeat(8) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('manifest-digest-mismatch');
    expect(result.error.message).toContain('deadbeef');
  });

  it('a diverging image hash is refused naming the item and both hashes', async () => {
    const options = await trackedOptions();
    const firstTest = TRACKED_SPLIT.assignments.find(
      (assignment) => assignment.split === 'test',
    ) as { id: string; sha256: string };
    const result = buildScorecard({
      ...options,
      assetHashes: new Map([[firstTest.id, 'f'.repeat(64)]]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('manifest-digest-mismatch');
    expect(result.error.message).toContain(firstTest.id);
    expect(result.error.message).toContain(firstTest.sha256);
  });

  it('a malformed prediction set is refused naming the item', async () => {
    const options = await trackedOptions();
    const badId = 'candle/Data/Images/Anomaly/000.JPG';
    const result = buildScorecard({
      ...options,
      predictions: [...options.predictions, { id: badId, labelKey: 'normal', probability: 1.5 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('prediction-set-invalid');
    expect(result.error.message).toContain(badId);
    expect(result.error.message).toContain('1.5');
  });

  it('a non-finite latency is refused, never reported', async () => {
    const options = await trackedOptions();
    const badId = (TRACKED_SPLIT.assignments.find((a) => a.split === 'test') as { id: string }).id;
    const result = buildScorecard({
      ...options,
      predictions: [...options.predictions, { id: badId, labelKey: 'normal', latencyMs: Number.NaN }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('prediction-set-invalid');
    expect(result.error.message).toContain(badId);
  });

  it('missing predictions count as failures on the tracked split too', async () => {
    const result = buildScorecard(await trackedOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scorecard.coverage.missing).toBeGreaterThan(0);
    expect(result.scorecard.coverage.coverage).toBeLessThan(1);
    expect(result.scorecard.coverage.expected).toBe(140);
  });

  it('the dataset license gate refuses an unlicensed dataset entry', async () => {
    const options = await trackedOptions();
    const unlicensed = {
      ...(options.datasetEntry as Record<string, unknown>),
      license: '',
    };
    expect(() =>
      buildScorecard({
        ...options,
        datasetEntry: unlicensed as unknown as BuildScorecardOptions['datasetEntry'],
      }),
    ).toThrowError(/license/);
  });
});

// ---------------------------------------------------------------------------
// SC-007: the retired baseline and the regime rule
// ---------------------------------------------------------------------------

describe('prior baselines and the regime (SC-007, FR-013, FR-014, FR-020)', () => {
  it(
    'the retired all-train baseline is listed with holdout false and its recorded reason',
    async () => {
      const result = buildScorecard(await trackedOptions());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const retired = result.scorecard.priorBaselines.find((entry) => entry.status === 'retired');
      expect(retired).toBeDefined();
      expect(retired?.holdout).toBe(false);
      expect(retired?.macroF1).toBeCloseTo(0.9795123004395695, 12);
      expect(retired?.splitFingerprint).toBe(FROZEN_V1_SPLIT.manifestHash);
      expect(retired?.retiredReason).toContain('VLN-007');
    },
    20000,
  );

  it('the guard refuses a whole-set baseline against a test-partition scorecard', async () => {
    const result = buildScorecard(await trackedOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const wholeSetBaseline: BaselineEntry = {
      suite: 'visa-subset.v2',
      model: 'gpt-4o',
      modelVersion: 'model:gpt-4o@2024-11-20',
      macroF1: 0.95,
      perClass: {},
      splitFingerprint: TRACKED_SPLIT.manifestHash,
      status: 'active',
      generatedAt: NOW.toISOString(),
    };
    const check = checkScorecardBaseline(result.scorecard, wholeSetBaseline);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error.code).toBe('baseline-regime-mismatch');
    expect(check.error.message).toContain(WHOLE_SET_REGIME);
    expect(check.error.message).toContain(SCORECARD_REGIME);
  });

  it('the guard refuses a retired baseline, quoting its reason', () => {
    const retiredFile: BaselineFile | undefined = readBaselineFile(
      path.join(REPO_ROOT, 'benchmarks', 'baselines', 'visa-subset.json'),
    );
    expect(retiredFile).toBeDefined();
    const retired = retiredFile?.entries[0] as BaselineEntry;
    const scorecard = { regime: SCORECARD_REGIME, manifestSha256: 'x', scorecardId: 's', partial: false } as unknown as Scorecard;
    const check = checkScorecardBaseline(scorecard, retired);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error.code).toBe('baseline-regime-mismatch');
    expect(check.error.message).toContain('retired');
    expect(check.error.message).toContain('VLN-007');
  });

  it('the guard refuses a baseline of another split, naming both digests', () => {
    const scorecard = {
      regime: SCORECARD_REGIME,
      manifestSha256: 'aaaa',
      scorecardId: 'sc-1',
      partial: false,
    } as unknown as Scorecard;
    const other = {
      suite: 's',
      model: 'm',
      macroF1: 0.9,
      perClass: {},
      splitFingerprint: 'bbbb',
      generatedAt: NOW.toISOString(),
    } as BaselineEntry;
    const check = checkScorecardBaseline(scorecard, other);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error.code).toBe('manifest-digest-mismatch');
    expect(check.error.message).toContain('aaaa');
    expect(check.error.message).toContain('bbbb');
  });

  it('the guard refuses a partial scorecard and the scorecard is marked partial', async () => {
    const options = await trackedOptions();
    const partial = buildScorecard({ ...options, partial: true });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.scorecard.partial).toBe(true);
    expect(partial.scorecard.limitations.some((entry) => entry.includes('PARTIAL'))).toBe(true);

    const baseline: BaselineEntry = {
      suite: 'visa-subset.v2',
      model: 'gpt-4o',
      macroF1: 0.9,
      perClass: {},
      splitFingerprint: TRACKED_SPLIT.manifestHash,
      generatedAt: NOW.toISOString(),
    };
    // A baseline recorded from a scorecard says so through a regime field
    // (FR-014); the entry type of the shipped gate does not carry it yet.
    Object.assign(baseline, { regime: SCORECARD_REGIME });
    const check = checkScorecardBaseline(partial.scorecard, baseline);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error.code).toBe('baseline-regime-mismatch');
    expect(check.error.message).toContain('partial');
  });

  it('the guard accepts a scorecard-regime baseline of the same split', () => {
    const scorecard = {
      regime: SCORECARD_REGIME,
      manifestSha256: 'aaaa',
      scorecardId: 'sc-1',
      partial: false,
    } as unknown as Scorecard;
    const matching: BaselineEntry = {
      suite: 's',
      model: 'm',
      macroF1: 0.9,
      perClass: {},
      splitFingerprint: 'aaaa',
      generatedAt: NOW.toISOString(),
    };
    Object.assign(matching, { regime: SCORECARD_REGIME });
    expect(checkScorecardBaseline(scorecard, matching).ok).toBe(true);
  });
});
