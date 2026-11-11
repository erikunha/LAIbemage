import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_BIN_COUNT,
  computeCalibration,
  confidenceBinIndex,
} from '../../src/benchmark/calibration.js';
import type { GoldItem, PredictionItem } from '../../src/benchmark/metrics.js';

// ---------------------------------------------------------------------------
// Fixture 1 — planted overconfidence (spec 003 US3 acceptance scenario 2).
//
// 10 items, every probability 0.75 → every item lands in bin 7 ([0.7, 0.8)).
// 5 items are correct, 5 are wrong.
//
// Hand arithmetic:
//   n_7 = 10, N = 10
//   acc_7 = 5 / 10 = 0.5
//   conf_7 = (10 * 0.75) / 10 = 0.75
//   |acc_7 - conf_7| = |0.5 - 0.75| = 0.25
//   ECE = (n_7 / N) * |acc_7 - conf_7| = (10 / 10) * 0.25 = 0.25
// ---------------------------------------------------------------------------

const OVERCONFIDENT_GOLD: GoldItem[] = [
  { id: 'i01', labelKey: 'a' },
  { id: 'i02', labelKey: 'a' },
  { id: 'i03', labelKey: 'a' },
  { id: 'i04', labelKey: 'a' },
  { id: 'i05', labelKey: 'a' },
  { id: 'i06', labelKey: 'b' },
  { id: 'i07', labelKey: 'b' },
  { id: 'i08', labelKey: 'b' },
  { id: 'i09', labelKey: 'b' },
  { id: 'i10', labelKey: 'b' },
];

const OVERCONFIDENT_PREDICTIONS: PredictionItem[] = [
  { id: 'i01', labelKey: 'a', probability: 0.75 },
  { id: 'i02', labelKey: 'a', probability: 0.75 },
  { id: 'i03', labelKey: 'a', probability: 0.75 },
  { id: 'i04', labelKey: 'a', probability: 0.75 },
  { id: 'i05', labelKey: 'a', probability: 0.75 },
  { id: 'i06', labelKey: 'a', probability: 0.75 },
  { id: 'i07', labelKey: 'a', probability: 0.75 },
  { id: 'i08', labelKey: 'a', probability: 0.75 },
  { id: 'i09', labelKey: 'a', probability: 0.75 },
  { id: 'i10', labelKey: 'a', probability: 0.75 },
];

describe('benchmark calibration — planted overconfidence (SC-002: exact to 1e-9)', () => {
  const calibration = computeCalibration(OVERCONFIDENT_GOLD, OVERCONFIDENT_PREDICTIONS);

  it('matches the analytically known ECE (0.25)', () => {
    expect(calibration.ece).toBeCloseTo(0.25, 9);
    expect(calibration.itemsScored).toBe(10);
    expect(calibration.itemsWithoutProbability).toBe(0);
  });

  it('puts every item in bin 7 with the hand-computed reliability data', () => {
    expect(calibration.bins).toHaveLength(CALIBRATION_BIN_COUNT);
    const bin7 = calibration.bins[7];
    expect(bin7).toEqual({
      index: 7,
      lower: 0.7,
      upper: 0.8,
      count: 10,
      meanConfidence: 0.75,
      accuracy: 0.5,
    });
    // Every other bin is empty.
    for (const bin of calibration.bins) {
      if (bin.index === 7) continue;
      expect(bin.count).toBe(0);
      expect(bin.meanConfidence).toBe(0);
      expect(bin.accuracy).toBe(0);
    }
  });

  it('is deterministic', () => {
    const again = computeCalibration(OVERCONFIDENT_GOLD, OVERCONFIDENT_PREDICTIONS);
    expect(again).toEqual(calibration);
    expect(JSON.stringify(again)).toBe(JSON.stringify(calibration));
  });
});

describe('benchmark calibration — bin weighting', () => {
  it('weights each bin by its share of the items', () => {
    // 6 items with p = 0.5 (bin 5) and 4 items with p = 0.75 (bin 7), all correct.
    //   ECE = (6/10)*|1 - 0.5| + (4/10)*|1 - 0.75|
    //       = 0.6 * 0.5 + 0.4 * 0.25
    //       = 0.3 + 0.1
    //       = 0.4
    const gold: GoldItem[] = [];
    const predictions: PredictionItem[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = `w${String(index).padStart(2, '0')}`;
      gold.push({ id, labelKey: 'a' });
      predictions.push({ id, labelKey: 'a', probability: index < 6 ? 0.5 : 0.75 });
    }
    const calibration = computeCalibration(gold, predictions);
    expect(calibration.ece).toBeCloseTo(0.4, 9);
    expect(calibration.bins[5]?.count).toBe(6);
    expect(calibration.bins[5]?.meanConfidence).toBe(0.5);
    expect(calibration.bins[5]?.accuracy).toBe(1);
    expect(calibration.bins[7]?.count).toBe(4);
    expect(calibration.bins[7]?.meanConfidence).toBe(0.75);
    expect(calibration.bins[7]?.accuracy).toBe(1);
  });

  it('reports 0 for a perfectly calibrated set', () => {
    // 10 items with p = 0.5, 5 of them correct: acc = 0.5 = conf → |0.5 - 0.5| = 0.
    const gold: GoldItem[] = [];
    const predictions: PredictionItem[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = `c${String(index).padStart(2, '0')}`;
      gold.push({ id, labelKey: index < 5 ? 'a' : 'b' });
      predictions.push({ id, labelKey: 'a', probability: 0.5 });
    }
    const calibration = computeCalibration(gold, predictions);
    expect(calibration.ece).toBe(0);
    expect(calibration.bins[5]?.accuracy).toBe(0.5);
    expect(calibration.bins[5]?.meanConfidence).toBe(0.5);
  });

  it('reports the full error when a confident model is always wrong', () => {
    // 10 wrong items with p = 0.9: acc = 0, conf = 0.9 → ECE = 0.9.
    const gold: GoldItem[] = [];
    const predictions: PredictionItem[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = `x${String(index).padStart(2, '0')}`;
      gold.push({ id, labelKey: 'a' });
      predictions.push({ id, labelKey: 'b', probability: 0.9 });
    }
    const calibration = computeCalibration(gold, predictions);
    expect(calibration.ece).toBeCloseTo(0.9, 9);
    expect(calibration.bins[9]?.count).toBe(10);
    expect(calibration.bins[9]?.accuracy).toBe(0);
    // Mean of ten 0.9 values — the sum accumulates a 1e-16 representation error.
    expect(calibration.bins[9]?.meanConfidence).toBeCloseTo(0.9, 12);
  });

  it('pins the bin membership of mixed confidences (a shifted edge changes the ECE)', () => {
    // 4 items with p = 0.55 (bin 5, [0.5, 0.6)), 2 of them correct
    // 6 items with p = 0.65 (bin 6, [0.6, 0.7)), all correct
    //
    // Hand arithmetic:
    //   bin 5: n = 4, acc = 2/4 = 0.5, conf = 0.55 → |0.5 - 0.55| = 0.05
    //          contribution = (4/10) * 0.05 = 0.02
    //   bin 6: n = 6, acc = 6/6 = 1,   conf = 0.65 → |1 - 0.65|   = 0.35
    //          contribution = (6/10) * 0.35 = 0.21
    //   ECE = 0.02 + 0.21 = 0.23
    // If the bin edge moved, the two groups would merge into one bin and the
    // ECE would become |0.8 - 0.61| = 0.19 — so this fixture pins the edges.
    const gold: GoldItem[] = [];
    const predictions: PredictionItem[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = `m${String(index).padStart(2, '0')}`;
      const low = index < 4;
      // index 0,1 → correct (p = 0.55); index 2,3 → wrong (p = 0.55);
      // index 4..9 → correct (p = 0.65).
      const goldLabel = index < 2 ? 'a' : low ? 'b' : 'a';
      gold.push({ id, labelKey: goldLabel });
      predictions.push({ id, labelKey: 'a', probability: low ? 0.55 : 0.65 });
    }
    const calibration = computeCalibration(gold, predictions);
    expect(calibration.ece).toBeCloseTo(0.23, 9);
    expect(calibration.bins[5]?.count).toBe(4);
    expect(calibration.bins[5]?.meanConfidence).toBeCloseTo(0.55, 12);
    expect(calibration.bins[5]?.accuracy).toBe(0.5);
    expect(calibration.bins[6]?.count).toBe(6);
    expect(calibration.bins[6]?.meanConfidence).toBeCloseTo(0.65, 12);
    expect(calibration.bins[6]?.accuracy).toBe(1);
  });
});

describe('benchmark calibration — bin edges (pinned convention)', () => {
  it('maps a confidence of 0.0 to bin 0 and 1.0 to the closed last bin', () => {
    expect(confidenceBinIndex(0)).toBe(0);
    expect(confidenceBinIndex(1)).toBe(9);
    expect(confidenceBinIndex(0.1)).toBe(1);
    expect(confidenceBinIndex(0.3)).toBe(3);
    expect(confidenceBinIndex(0.999999)).toBe(9);
    expect(confidenceBinIndex(0.0999999)).toBe(0);
  });

  it('reports the bin edges in ascending order', () => {
    const calibration = computeCalibration([], []);
    expect(calibration.bins.map((bin) => bin.lower)).toEqual([
      0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
    ]);
    expect(calibration.bins.map((bin) => bin.upper)).toEqual([
      0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
    ]);
    expect(calibration.bins.map((bin) => bin.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('benchmark calibration — edge cases', () => {
  it('returns a defined result for an empty input (never NaN)', () => {
    const calibration = computeCalibration([], []);
    expect(calibration.ece).toBe(0);
    expect(calibration.itemsScored).toBe(0);
    expect(calibration.itemsWithoutProbability).toBe(0);
    expect(calibration.bins).toHaveLength(CALIBRATION_BIN_COUNT);
    expect(calibration.bins.every((bin) => bin.count === 0)).toBe(true);
  });

  it('handles a single item', () => {
    // 1 correct item with p = 0.6 → acc = 1, conf = 0.6 → ECE = 0.4.
    const calibration = computeCalibration(
      [{ id: 'only', labelKey: 'a' }],
      [{ id: 'only', labelKey: 'a', probability: 0.6 }],
    );
    expect(calibration.itemsScored).toBe(1);
    expect(calibration.ece).toBeCloseTo(0.4, 9);
    expect(calibration.bins[6]?.count).toBe(1);
    expect(calibration.bins[6]?.meanConfidence).toBe(0.6);
    expect(calibration.bins[6]?.accuracy).toBe(1);
  });

  it('counts the items without a probability and excludes them from the ECE', () => {
    const calibration = computeCalibration(
      [
        { id: 'p1', labelKey: 'a' },
        { id: 'p2', labelKey: 'a' },
      ],
      [
        { id: 'p1', labelKey: 'a', probability: 0.5 },
        { id: 'p2', labelKey: 'a' },
      ],
    );
    expect(calibration.itemsScored).toBe(1);
    expect(calibration.itemsWithoutProbability).toBe(1);
    // The single binned item is correct: |1 - 0.5| = 0.5.
    expect(calibration.ece).toBeCloseTo(0.5, 9);
  });

  it('rejects a probability outside [0, 1] instead of clamping it', () => {
    expect(() =>
      computeCalibration(
        [{ id: 'bad', labelKey: 'a' }],
        [{ id: 'bad', labelKey: 'a', probability: 1.5 }],
      ),
    ).toThrow(RangeError);
    expect(() =>
      computeCalibration(
        [{ id: 'bad', labelKey: 'a' }],
        [{ id: 'bad', labelKey: 'a', probability: -0.1 }],
      ),
    ).toThrow(/invalid probability/);
    expect(() =>
      computeCalibration(
        [{ id: 'bad', labelKey: 'a' }],
        [{ id: 'bad', labelKey: 'a', probability: Number.NaN }],
      ),
    ).toThrow(RangeError);
    // The error names the offending item so the failure is actionable.
    expect(() =>
      computeCalibration(
        [{ id: 'bad', labelKey: 'a' }],
        [{ id: 'bad', labelKey: 'a', probability: 2 }],
      ),
    ).toThrow(/"bad"/);
  });
});
