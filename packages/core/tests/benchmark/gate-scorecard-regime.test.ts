/**
 * The scorecard regime check wired into the gate (spec 022, tasks 4.7 and
 * 4.8: FR-014, FR-020, SC-007).
 *
 * The gate's split-identity checks cannot tell a test-partition scorecard
 * number from a whole-set number: the two share a split fingerprint. These
 * tests pin the wiring that routes a scorecard-carrying run through the
 * scorecard's own guard (`checkScorecardBaseline`) BEFORE any macro F1 is
 * compared, with the guard's typed error codes surfaced in the gate's reason.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateGate,
  readBaselineFile,
  writeBaselineFile,
  type BaselineEntry,
  type BaselineFile,
} from '../../src/benchmark/gate.js';
import {
  scoreMetrics,
  type GoldItem,
  type PredictionItem,
} from '../../src/benchmark/metrics.js';
import {
  SCORECARD_REGIME,
  WHOLE_SET_REGIME,
  type Scorecard,
  type ScorecardErrorCode,
} from '../../src/benchmark/scorecard.js';

/** The typed refusal codes the gate must surface, taken from the shipped union. */
const REGIME_MISMATCH: ScorecardErrorCode = 'baseline-regime-mismatch';
const DIGEST_MISMATCH: ScorecardErrorCode = 'manifest-digest-mismatch';

const SUITE = 'synthetic';
const MODEL = 'demo';
const GENERATED_AT = '2026-01-01T00:00:00.000Z';
/** The manifest hash of the split the scorecard run was measured against. */
const TRACKED_HASH = 'hash-tracked';
/** The manifest hash of a split the scorecard run was NOT measured against. */
const OTHER_SPLIT_HASH = 'hash-other-split';
const RETIRED_REASON =
  'measured on the degenerate all-train split: with zero held-out images the ' +
  'number is not a performance figure';

/**
 * A gold set of `size` items over two classes, `correctCount` of them right,
 * so the gate has a macro F1 to reason about (the shape of gate.test.ts).
 */
function buildRunMetrics(correctCount: number, size = 10): ReturnType<typeof scoreMetrics> {
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
  return scoreMetrics(gold, predictions);
}

/**
 * The run's scorecard, reduced to the fields the guard reads. The gate
 * forwards the artifact unchanged to `checkScorecardBaseline`, so this pins
 * the wiring; the builder's own suite covers the full artifact.
 */
function scorecardOf(overrides: { partial?: boolean; manifestSha256?: string } = {}): Scorecard {
  return {
    regime: SCORECARD_REGIME,
    scorecardId: 'sc-gate-fixture',
    manifestSha256: TRACKED_HASH,
    partial: false,
    ...overrides,
  } as unknown as Scorecard;
}

/**
 * Mark a baseline entry as recorded FROM a scorecard: it says so through a
 * `regime` field (FR-014). The refusal tests inject the field by hand so they
 * stay focused on the refusal; the matching-regime path goes through the
 * gate's own write path instead.
 */
function withRegime(entry: BaselineEntry): BaselineEntry {
  return Object.assign(entry, { regime: SCORECARD_REGIME });
}

/** A split manifest the gate can read: the manifest hash and three partitions. */
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

/** A baseline entry of this suite/model pair, with the caller's extras. */
function baselineEntry(
  macroF1: number,
  perClass: Record<string, number>,
  extra: Partial<BaselineEntry> = {},
): BaselineEntry {
  return {
    suite: SUITE,
    model: MODEL,
    macroF1,
    perClass,
    ...extra,
    generatedAt: GENERATED_AT,
  };
}

describe('the gate routes a scorecard run through the scorecard regime guard', () => {
  let dir: string;
  let baselinePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-gate-scorecard-'));
    baselinePath = path.join(dir, 'synthetic.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a retired all-train baseline with its recorded reason (FR-020)', () => {
    const metrics = buildRunMetrics(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      entries: [
        baselineEntry(0.99, { alpha: 0.99, beta: 0.99 }, {
          status: 'retired',
          retiredReason: RETIRED_REASON,
          splitFingerprint: 'hash-all-train',
        }),
      ],
    });

    const result = evaluateGate({
      suite: SUITE,
      model: MODEL,
      metrics,
      baselinePath,
      scorecard: scorecardOf(),
    });

    // Not the SKIP a retired entry produces for a whole-set run: against a
    // scorecard the retired number is refused, so it cannot bless the run.
    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain(REGIME_MISMATCH);
    expect(result.reason).toContain('retired');
    expect(result.reason).toContain(RETIRED_REASON);
    // The macro F1 was NOT compared.
    expect(result.macroF1Delta).toBe(0);
    expect(result.deltas).toEqual([]);
    expect(result.regressedClasses).toEqual([]);
  });

  it('refuses a scorecard baseline of ANOTHER split, naming both digests', () => {
    const metrics = buildRunMetrics(8);
    // The baseline is in the scorecard regime and on the tracked fingerprint:
    // the only thing that can refuse it is the split digest.
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      entries: [
        withRegime(
          baselineEntry(0.9, { alpha: 0.9, beta: 0.9 }, { splitFingerprint: OTHER_SPLIT_HASH }),
        ),
      ],
    });

    const result = evaluateGate({
      suite: SUITE,
      model: MODEL,
      metrics,
      baselinePath,
      scorecard: scorecardOf(),
    });

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain(DIGEST_MISMATCH);
    // Both digests are named: the baseline's and the scorecard's.
    expect(result.reason).toContain(OTHER_SPLIT_HASH);
    expect(result.reason).toContain(TRACKED_HASH);
    expect(result.macroF1Delta).toBe(0);
  });

  it('refuses a PARTIAL scorecard even against a matching baseline (FR-020)', () => {
    const metrics = buildRunMetrics(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      entries: [
        withRegime(
          baselineEntry(0.9, { alpha: 0.9, beta: 0.9 }, { splitFingerprint: TRACKED_HASH }),
        ),
      ],
    });

    // The run's own partial flag is NOT set: the scorecard artifact says the
    // scoring set was incomplete, and that alone must refuse the comparison.
    const result = evaluateGate({
      suite: SUITE,
      model: MODEL,
      metrics,
      baselinePath,
      scorecard: scorecardOf({ partial: true }),
    });

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain(REGIME_MISMATCH);
    expect(result.reason).toContain('partial');
    expect(result.macroF1Delta).toBe(0);
  });

  it('refuses a whole-set baseline against a test-partition scorecard, naming both regimes (FR-014)', () => {
    const metrics = buildRunMetrics(8);
    // No regime field: a baseline written by the whole-set runner. It shares
    // the split fingerprint with the scorecard, so only the regime refuses it.
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      entries: [
        baselineEntry(0.9, { alpha: 0.9, beta: 0.9 }, { splitFingerprint: TRACKED_HASH }),
      ],
    });

    const result = evaluateGate({
      suite: SUITE,
      model: MODEL,
      metrics,
      baselinePath,
      scorecard: scorecardOf(),
    });

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain(REGIME_MISMATCH);
    expect(result.reason).toContain(WHOLE_SET_REGIME);
    expect(result.reason).toContain(SCORECARD_REGIME);
    expect(result.macroF1Delta).toBe(0);
  });

  it('records the regime on a scorecard baseline, so the next scorecard compares normally (FR-014)', () => {
    const metrics = buildRunMetrics(8);
    const splitsDir = path.join(dir, 'splits');
    writeSplitFile(path.join(splitsDir, 'tracked.gold.json'), TRACKED_HASH);
    // The whole-set past: a retired entry with no regime, exactly what the
    // whole-set runner writes.
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      entries: [
        baselineEntry(0.99, { alpha: 0.99, beta: 0.99 }, {
          status: 'retired',
          retiredReason: RETIRED_REASON,
        }),
      ],
    });

    // The migration itself: record a new baseline FROM the scorecard run
    // through the gate's real write path.
    const recorded = evaluateGate({
      suite: SUITE,
      model: MODEL,
      metrics,
      baselinePath,
      updateBaseline: true,
      scorecard: scorecardOf(),
      attribution: { splitFingerprint: TRACKED_HASH },
      now: new Date('2026-03-04T05:06:07.000Z'),
    });

    expect(recorded.updated).toBe(true);

    // The written file, read back through the gate's own reader, carries the
    // regime on the new entry: no fabricated field anywhere.
    const file = readBaselineFile(baselinePath) as BaselineFile;
    const active = file.entries.find((entry) => entry.status !== 'retired');
    expect(active?.regime).toBe(SCORECARD_REGIME);

    // A second scorecard run against that WRITTEN baseline compares normally:
    // the regime guard admits the matching regime and the gate resolves the
    // split identity through its existing checks.
    const result = evaluateGate({
      suite: SUITE,
      model: MODEL,
      metrics,
      baselinePath,
      scorecard: scorecardOf(),
      currentSplitPath: path.join(splitsDir, 'tracked.gold.json'),
      splitsDir,
      attribution: { splitFingerprint: TRACKED_HASH },
    });

    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.macroF1Delta).toBeCloseTo(0, 12);
    expect(result.reason).toMatch(/macro F1 moved/i);
    expect(result.baseline?.macroF1).toBe(metrics.macroF1);
    expect(result.baseline?.regime).toBe(SCORECARD_REGIME);
    expect(result.split).toEqual({
      recordedSplitId: 'tracked.gold',
      currentSplitId: 'tracked.gold',
    });
  });

  it('lets a scorecard run RECORD a new baseline past a retired entry', () => {
    const metrics = buildRunMetrics(8);
    writeBaselineFile(baselinePath, {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      entries: [
        baselineEntry(0.99, { alpha: 0.99, beta: 0.99 }, {
          status: 'retired',
          retiredReason: RETIRED_REASON,
        }),
      ],
    });

    const result = evaluateGate({
      suite: SUITE,
      model: MODEL,
      metrics,
      baselinePath,
      updateBaseline: true,
      scorecard: scorecardOf(),
      now: new Date('2026-03-04T05:06:07.000Z'),
    });

    // The regime check compares against the baseline recorded NOW, so a
    // baseline rewrite is exempt: recording a new baseline is how a suite
    // migrates from the whole-set regime to the scorecard regime.
    expect(result.updated).toBe(true);
    const file = readBaselineFile(baselinePath) as BaselineFile;
    expect(file.entries).toHaveLength(2);
    expect(file.entries.filter((entry) => entry.status === 'retired')).toHaveLength(1);
    expect(file.entries.filter((entry) => entry.status !== 'retired')).toHaveLength(1);
  });
});
