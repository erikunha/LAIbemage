/**
 * The v2 split strategies — VLN-007 (leakage-resistant splits).
 *
 * The tracked VisA split (schemaVersion 1) put EVERY assignment in `train`:
 * the upstream release carries no capture-session column, so the capture group
 * of an item is its object class, one group per class, and a group larger than
 * any quota cannot be divided. The measured macro F1 was therefore computed
 * with zero validation and zero test images.
 *
 * What is proven here:
 *  - the `stratified` strategy produces a REAL train/val/test partition where
 *    the `grouped` strategy provably cannot;
 *  - the partition is stratified (per-class and per-anomaly proportions are
 *    respected), deterministic for a fixed seed and seed-sensitive;
 *  - the manifest records the strategy, the partition fingerprint and the fact
 *    that the capture-group property was NOT enforced;
 *  - the `grouped` strategy still behaves exactly as it did (the frozen
 *    schemaVersion 1 manifest still validates, and a one-group-per-stratum
 *    dataset still degenerates to an all-train split);
 *  - the gate refuses to bless a number whose split is not the tracked one.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computePartitionFingerprint,
  generateSplitManifest,
  validateSplitManifestHashes,
  type SplitItem,
  type SplitManifest,
} from '../../src/benchmark/splits.js';
import {
  evaluateGate,
  writeBaselineFile,
  type BaselineFile,
} from '../../src/benchmark/gate.js';
import {
  scoreMetrics,
  type GoldItem,
  type PredictionItem,
} from '../../src/benchmark/metrics.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function makeItem(id: string, overrides: Partial<SplitItem> = {}): SplitItem {
  return {
    id,
    class: 'pcb1',
    anomaly: 'normal',
    sha256: createHash('sha256').update(id).digest('hex'),
    path: `${id}.JPG`,
    ...overrides,
  };
}

/**
 * The shape of the real VisA subset: four object classes, each with a hundred
 * anomalous and seventy-five normal images, and ONE capture group per class
 * (the upstream release carries no session column).
 */
function makeVisaLikeDataset(): SplitItem[] {
  const items: SplitItem[] = [];
  for (const className of ['candle', 'capsules', 'fryum', 'pcb1']) {
    for (const anomaly of ['normal', 'anomalous'] as const) {
      const total = anomaly === 'anomalous' ? 100 : 75;
      for (let index = 0; index < total; index += 1) {
        const id = `${className}/${anomaly}/${String(index).padStart(3, '0')}`;
        items.push(
          makeItem(id, {
            class: className,
            anomaly,
            group: className,
          }),
        );
      }
    }
  }
  return items;
}

const BASE_OPTIONS = {
  id: 'test.gold',
  datasetId: 'test-dataset',
  seed: 42,
} as const;

/* ------------------------------------------------------------------ *
 * 1. The stratified strategy is not degenerate
 * ------------------------------------------------------------------ */

describe('the stratified strategy', () => {
  it('produces a real partition where the grouped strategy degenerates', () => {
    const items = makeVisaLikeDataset();

    const grouped = generateSplitManifest({ ...BASE_OPTIONS, items });
    const stratified = generateSplitManifest({
      ...BASE_OPTIONS,
      items,
      strategy: 'stratified',
    });

    // The grouped strategy cannot divide a group that is larger than any
    // quota, so every item lands in `train` — the defect this strategy fixes.
    const groupedSplits = new Set(grouped.assignments.map((a) => a.split));
    expect([...groupedSplits]).toEqual(['train']);

    const stratifiedSplits = new Set(stratified.assignments.map((a) => a.split));
    expect([...stratifiedSplits].sort()).toEqual(['test', 'train', 'val']);
    for (const split of ['train', 'val', 'test'] as const) {
      expect(stratified.assignments.filter((a) => a.split === split).length).toBeGreaterThan(0);
    }
  });

  it('respects the per-class and per-anomaly proportions', () => {
    const items = makeVisaLikeDataset();
    const manifest = generateSplitManifest({
      ...BASE_OPTIONS,
      items,
      strategy: 'stratified',
    });

    const total = manifest.assignments.length;
    expect(total).toBe(items.length);

    // The global 60/20/20 partition.
    const counts = { train: 0, val: 0, test: 0 };
    for (const assignment of manifest.assignments) counts[assignment.split] += 1;
    expect(counts.train / total).toBeCloseTo(0.6, 6);
    expect(counts.val / total).toBeCloseTo(0.2, 6);
    expect(counts.test / total).toBeCloseTo(0.2, 6);

    // Every class is present in every partition, in the same proportion.
    for (const className of ['candle', 'capsules', 'fryum', 'pcb1']) {
      const ofClass = manifest.assignments.filter((a) => a.class === className);
      expect(ofClass.length).toBe(175);
      for (const split of ['train', 'val', 'test'] as const) {
        const ofSplit = ofClass.filter((a) => a.split === split);
        expect(ofSplit.length).toBeGreaterThan(0);
        expect(ofSplit.length / ofClass.length).toBeCloseTo(
          split === 'train' ? 0.6 : 0.2,
          6,
        );
      }
    }

    // Both anomaly kinds are present in every partition, in proportion.
    for (const anomaly of ['normal', 'anomalous'] as const) {
      const ofAnomaly = manifest.assignments.filter((a) => a.anomaly === anomaly);
      expect(ofAnomaly.length).toBeGreaterThan(0);
      for (const split of ['train', 'val', 'test'] as const) {
        const ofSplit = ofAnomaly.filter((a) => a.split === split);
        expect(ofSplit.length).toBeGreaterThan(0);
        expect(ofSplit.length / ofAnomaly.length).toBeCloseTo(
          split === 'train' ? 0.6 : 0.2,
          6,
        );
      }
    }

    // The recorded stratum counts match the assignments.
    for (const stratum of manifest.strata) {
      const inStratum = manifest.assignments.filter(
        (a) => a.class === stratum.class && a.anomaly === stratum.anomaly,
      );
      expect(inStratum.filter((a) => a.split === 'train').length).toBe(stratum.train);
      expect(inStratum.filter((a) => a.split === 'val').length).toBe(stratum.val);
      expect(inStratum.filter((a) => a.split === 'test').length).toBe(stratum.test);
    }
  });

  it('is deterministic for a fixed seed and different for a different seed', () => {
    const items = makeVisaLikeDataset();
    const first = generateSplitManifest({ ...BASE_OPTIONS, items, strategy: 'stratified' });
    const second = generateSplitManifest({ ...BASE_OPTIONS, items, strategy: 'stratified' });
    expect(second.manifestHash).toBe(first.manifestHash);
    expect(second.assignments).toEqual(first.assignments);

    const other = generateSplitManifest({
      ...BASE_OPTIONS,
      seed: 43,
      items,
      strategy: 'stratified',
    });
    expect(other.manifestHash).not.toBe(first.manifestHash);
    expect(other.assignments.map((a) => `${a.id}:${a.split}`)).not.toEqual(
      first.assignments.map((a) => `${a.id}:${a.split}`),
    );
  });

  it('does not depend on the order in which the items are supplied', () => {
    const items = makeVisaLikeDataset();
    const forward = generateSplitManifest({ ...BASE_OPTIONS, items, strategy: 'stratified' });
    const backward = generateSplitManifest({
      ...BASE_OPTIONS,
      items: items.slice().reverse(),
      strategy: 'stratified',
    });
    expect(backward.manifestHash).toBe(forward.manifestHash);
  });
});

/* ------------------------------------------------------------------ *
 * 2. What the manifest records
 * ------------------------------------------------------------------ */

describe('the manifest of a stratified split', () => {
  it('records the strategy, the partition fingerprint and the group basis', () => {
    const items = makeVisaLikeDataset();
    const manifest = generateSplitManifest({
      ...BASE_OPTIONS,
      items,
      strategy: 'stratified',
    });

    expect(manifest.strategy).toBe('stratified');
    expect(manifest.partitionFingerprint).toBe(computePartitionFingerprint(manifest.assignments));
    expect(manifest.partitionFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The reader must be able to tell that the partition is ITEM-LEVEL.
    expect(manifest.groupBasis?.captureGroupsEnforced).toBe(false);
    expect(manifest.groupBasis?.oversizedCaptureGroupCount).toBeGreaterThan(0);
    expect(manifest.groupBasis?.statement).toMatch(/item-level/i);
    expect(manifest.groupBasis?.statement).toMatch(/not/i);
  });

  it('records that the grouped strategy DID enforce the capture groups', () => {
    const items = makeVisaLikeDataset();
    const manifest = generateSplitManifest({ ...BASE_OPTIONS, items });
    expect(manifest.strategy).toBe('grouped');
    expect(manifest.groupBasis?.captureGroupsEnforced).toBe(true);
    expect(manifest.partitionFingerprint).toBe(computePartitionFingerprint(manifest.assignments));
  });

  it('validates against the manifest hash of its own content', () => {
    const manifest = generateSplitManifest({
      ...BASE_OPTIONS,
      items: makeVisaLikeDataset(),
      strategy: 'stratified',
    });
    const result = validateSplitManifestHashes(manifest);
    expect(result.ok).toBe(true);
    expect(result.divergences).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The grouped strategy is unchanged
 * ------------------------------------------------------------------ */

describe('the grouped strategy still behaves as before', () => {
  it('keeps every capture group whole and records the overflow', () => {
    const manifest = generateSplitManifest({ ...BASE_OPTIONS, items: makeVisaLikeDataset() });

    // One group per class: the group is the atom and cannot be divided.
    for (const assignment of manifest.assignments) {
      const siblings = manifest.assignments.filter((a) => a.class === assignment.class);
      expect(new Set(siblings.map((a) => a.split)).size).toBe(1);
    }
    const overflow = manifest.notes.filter((note) =>
      note.reason.startsWith('capture-group-overflow:'),
    );
    expect(overflow.length).toBeGreaterThan(0);
  });

  it('leaves the frozen schemaVersion 1 manifest valid', () => {
    const frozen = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'benchmarks', 'splits', 'visa-subset.gold.json'), 'utf8'),
    ) as SplitManifest;
    const result = validateSplitManifestHashes(frozen);
    expect(result.ok).toBe(true);
    expect(frozen.schemaVersion).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The gate refuses a stale split
 * ------------------------------------------------------------------ */

describe('the gate and the split fingerprint', () => {
  let dir: string;

  function writeSplit(file: string, manifest: SplitManifest): void {
    // The split directory does not exist yet — the fixture creates it.
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  function metricsFor(manifest: SplitManifest) {
    const gold: GoldItem[] = manifest.assignments.map((a) => ({
      id: a.id,
      labelKey: a.anomaly === 'normal' ? 'normal' : `defect:${a.class}`,
    }));
    const predictions: PredictionItem[] = manifest.assignments.map((a) => ({
      id: a.id,
      labelKey: a.anomaly === 'normal' ? 'normal' : `defect:${a.class}`,
      probability: 0.9,
    }));
    return scoreMetrics(gold, predictions);
  }

  it('fails when the tracked split is not the split the predictions were made against', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-split-'));
    try {
      const items = makeVisaLikeDataset();
      const old = generateSplitManifest({ ...BASE_OPTIONS, items, strategy: 'stratified' });
      const current = generateSplitManifest({
        ...BASE_OPTIONS,
        seed: 43,
        items,
        strategy: 'stratified',
      });

      const splitsDir = path.join(dir, 'splits');
      writeSplit(path.join(splitsDir, 'demo.gold.json'), current);
      writeSplit(path.join(splitsDir, 'demo-v1.gold.json'), old);

      const baselinePath = path.join(dir, 'demo.json');
      const baseline: BaselineFile = {
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        entries: [
          {
            suite: 'demo',
            model: 'demo-model',
            macroF1: 0.9,
            perClass: { normal: 0.9 },
            splitFingerprint: old.manifestHash,
            generatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      writeBaselineFile(baselinePath, baseline);

      const result = evaluateGate({
        suite: 'demo',
        model: 'demo-model',
        metrics: metricsFor(current),
        baselinePath,
        currentSplitPath: path.join(splitsDir, 'demo.gold.json'),
        splitsDir,
        // The RUN was measured against the old split, so the gate must refuse
        // it: the run's own fingerprint is the identity of the split file it
        // was scored against.
        attribution: { splitFingerprint: old.manifestHash },
      });

      expect(result.passed).toBe(false);
      expect(result.skipped).toBe(false);
      // The message must name BOTH splits: the one that produced the
      // predictions and the one that is currently tracked.
      expect(result.reason).toContain('demo-v1.gold');
      expect(result.reason).toContain('demo.gold');
      expect(result.split?.recordedSplitId).toBe('demo-v1.gold');
      expect(result.split?.currentSplitId).toBe('demo.gold');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the tracked split has no held-out partition at all', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-degenerate-'));
    try {
      const items = makeVisaLikeDataset();
      const degenerate = generateSplitManifest({ ...BASE_OPTIONS, items });

      const splitsDir = path.join(dir, 'splits');
      writeSplit(path.join(splitsDir, 'demo.gold.json'), degenerate);

      const baselinePath = path.join(dir, 'demo.json');
      writeBaselineFile(baselinePath, {
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        entries: [
          {
            suite: 'demo',
            model: 'demo-model',
            macroF1: 0.9,
            perClass: { normal: 0.9 },
            splitFingerprint: degenerate.manifestHash,
            generatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });

      const result = evaluateGate({
        suite: 'demo',
        model: 'demo-model',
        metrics: metricsFor(degenerate),
        baselinePath,
        currentSplitPath: path.join(splitsDir, 'demo.gold.json'),
        splitsDir,
        attribution: { splitFingerprint: degenerate.manifestHash },
      });

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/no held-out|held-out partition/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when the tracked split IS the split the predictions were made against', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-match-'));
    try {
      const items = makeVisaLikeDataset();
      const manifest = generateSplitManifest({
        ...BASE_OPTIONS,
        items,
        strategy: 'stratified',
      });

      const splitsDir = path.join(dir, 'splits');
      writeSplit(path.join(splitsDir, 'demo.gold.json'), manifest);

      const baselinePath = path.join(dir, 'demo.json');
      writeBaselineFile(baselinePath, {
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        entries: [
          {
            suite: 'demo',
            model: 'demo-model',
            macroF1: 0.9,
            perClass: { normal: 0.9 },
            splitFingerprint: manifest.manifestHash,
            generatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });

      const result = evaluateGate({
        suite: 'demo',
        model: 'demo-model',
        metrics: metricsFor(manifest),
        baselinePath,
        currentSplitPath: path.join(splitsDir, 'demo.gold.json'),
        splitsDir,
        // The RUN was measured against the tracked split, and the tracked
        // baseline was recorded against it too.
        attribution: { splitFingerprint: manifest.manifestHash },
      });

      expect(result.passed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.split?.currentSplitId).toBe('demo.gold');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
