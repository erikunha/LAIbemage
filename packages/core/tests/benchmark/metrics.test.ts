import { describe, expect, it } from 'vitest';
import {
  computeAccuracyAtBudget,
  computeBalancedAccuracy,
  computeConfusionMatrix,
  computeCostSummary,
  computeLatencySummary,
  computeMacroF1,
  computePerClassMetrics,
  estimateItemCostUsd,
  joinGoldAndPredictions,
  percentile,
  scoreMetrics,
  type GoldItem,
  type PredictionItem,
  type ScoredItem,
} from '../../src/benchmark/metrics.js';

// ---------------------------------------------------------------------------
// The 10-item confusion fixture — written down BY HAND.
//
//   id   | gold | pred
//   -----+------+-----
//   i01  |  A   |  A     <- TP(A)
//   i02  |  A   |  A     <- TP(A)
//   i03  |  A   |  B     <- FN(A), FP(B)
//   i04  |  A   |  B     <- FN(A), FP(B)
//   i05  |  B   |  B     <- TP(B)
//   i06  |  B   |  B     <- TP(B)
//   i07  |  B   |  A     <- FN(B), FP(A)
//   i08  |  B   |  A     <- FN(B), FP(A)
//   i09  |  C   |  C     <- TP(C)
//   i10  |  C   |  X     <- FN(C), X is NOT in the gold vocabulary
//
// Hand arithmetic (no implementation involved):
//
//   gold counts      A = 4 (i01..i04), B = 4 (i05..i08), C = 2 (i09,i10)
//   predicted counts A = 4 (i01,i02,i07,i08), B = 4 (i03,i04,i05,i06),
//                     C = 1 (i09), X = 1 (i10)
//
//   class A: TP = 2, FP = 2 (i07,i08), FN = 2 (i03,i04)
//            precision = 2 / (2 + 2) = 0.5
//            recall    = 2 / 4         = 0.5
//            F1        = 2*0.5*0.5 / (0.5 + 0.5) = 0.5
//   class B: TP = 2, FP = 2 (i03,i04), FN = 2 (i07,i08)
//            precision = 2 / (2 + 2) = 0.5
//            recall    = 2 / 4         = 0.5
//            F1        = 0.5
//   class C: TP = 1, FP = 0,          FN = 1 (i10)
//            precision = 1 / (1 + 0)   = 1
//            recall    = 1 / 2         = 0.5
//            F1        = 2*1*0.5 / (1 + 0.5) = 1 / 1.5 = 2/3 ≈ 0.6666666666666666
//
//   macro F1          = (0.5 + 0.5 + 2/3) / 3 = (5/3) / 3 = 5/9 ≈ 0.5555555555555556
//   balanced accuracy = (0.5 + 0.5 + 0.5) / 3   = 0.5
//   overall accuracy  = 5 correct / 10 items    = 0.5   (i10 is wrong: X ∉ gold)
//
//   confusion matrix (rows = gold, columns = sorted {A, B, C, X}):
//     A | { A: 2, B: 2, C: 0, X: 0 }
//     B | { A: 2, B: 2, C: 0, X: 0 }
//     C | { A: 0, B: 0, C: 1, X: 1 }
//   row sums: A = 4, B = 4, C = 2 — equal to the gold counts.
// ---------------------------------------------------------------------------

const CONFUSION_GOLD: GoldItem[] = [
  { id: 'i01', labelKey: 'A' },
  { id: 'i02', labelKey: 'A' },
  { id: 'i03', labelKey: 'A' },
  { id: 'i04', labelKey: 'A' },
  { id: 'i05', labelKey: 'B' },
  { id: 'i06', labelKey: 'B' },
  { id: 'i07', labelKey: 'B' },
  { id: 'i08', labelKey: 'B' },
  { id: 'i09', labelKey: 'C' },
  { id: 'i10', labelKey: 'C' },
];

const CONFUSION_PREDICTIONS: PredictionItem[] = [
  { id: 'i01', labelKey: 'A' },
  { id: 'i02', labelKey: 'A' },
  { id: 'i03', labelKey: 'B' },
  { id: 'i04', labelKey: 'B' },
  { id: 'i05', labelKey: 'B' },
  { id: 'i06', labelKey: 'B' },
  { id: 'i07', labelKey: 'A' },
  { id: 'i08', labelKey: 'A' },
  { id: 'i09', labelKey: 'C' },
  { id: 'i10', labelKey: 'X' },
];

/** Stable JSON serialization (sorted object keys) for the determinism check. */
function stableStringify(value: unknown): string {
  const sortValue = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortValue);
    if (input !== null && typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
    }
    return input;
  };
  return JSON.stringify(sortValue(value));
}

/** Deterministic PRNG (mulberry32) — the property test must be reproducible in CI. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('benchmark metrics — hand-computed confusion fixture (spec 003 US3 / SC-002)', () => {
  const result = scoreMetrics(CONFUSION_GOLD, CONFUSION_PREDICTIONS);

  it('computes the hand-computed per-class precision / recall / F1', () => {
    expect(result.perClass).toHaveLength(3);

    const [a, b, c] = result.perClass;

    expect(a).toEqual({
      labelKey: 'A',
      support: 4,
      predicted: 4,
      truePositives: 2,
      falsePositives: 2,
      falseNegatives: 2,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
    });
    expect(b).toEqual({
      labelKey: 'B',
      support: 4,
      predicted: 4,
      truePositives: 2,
      falsePositives: 2,
      falseNegatives: 2,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
    });
    // F1 = 2·1·0.5 / 1.5 = 2/3 — the only non-terminating value of the fixture.
    expect(c).toEqual({
      labelKey: 'C',
      support: 2,
      predicted: 1,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 1,
      precision: 1,
      recall: 0.5,
      f1: 2 / 3,
    });
  });

  it('computes the hand-computed macro F1 and balanced accuracy', () => {
    // macro F1 = (0.5 + 0.5 + 2/3) / 3 = 5/9
    expect(result.macroF1).toBeCloseTo(5 / 9, 9);
    // balanced accuracy = (0.5 + 0.5 + 0.5) / 3 = 0.5
    expect(result.balancedAccuracy).toBe(0.5);
    // overall accuracy = 5 / 10
    expect(result.accuracy).toBe(0.5);
    expect(result.itemsScored).toBe(10);
    expect(result.correct).toBe(5);
  });

  it('computes the hand-computed confusion matrix', () => {
    expect(result.confusion.labels).toEqual(['A', 'B', 'C', 'X']);
    expect(result.confusion.rows).toEqual({
      A: { A: 2, B: 2, C: 0, X: 0 },
      B: { A: 2, B: 2, C: 0, X: 0 },
      C: { A: 0, B: 0, C: 1, X: 1 },
    });
  });

  it('records the unseen predicted label instead of silently dropping it', () => {
    expect(result.unseenPredictedLabels).toEqual([{ labelKey: 'X', count: 1 }]);
    // The unseen prediction is an error: it is not counted as correct.
    expect(result.correct).toBe(5);
    // …and it still occupies a cell of the matrix.
    expect(result.confusion.rows['C']?.['X']).toBe(1);
  });

  it('is deterministic: same input → deeply equal result and byte-identical JSON', () => {
    const again = scoreMetrics(CONFUSION_GOLD, CONFUSION_PREDICTIONS);
    expect(again).toEqual(result);
    expect(stableStringify(again)).toBe(stableStringify(result));
  });
});

describe('benchmark metrics — edge cases', () => {
  it('returns a defined result for an empty input (never NaN)', () => {
    const result = scoreMetrics([], []);
    expect(result.itemsScored).toBe(0);
    expect(result.correct).toBe(0);
    expect(result.accuracy).toBe(0);
    expect(result.perClass).toEqual([]);
    expect(result.macroF1).toBe(0);
    expect(result.balancedAccuracy).toBe(0);
    expect(result.confusion.labels).toEqual([]);
    expect(result.confusion.rows).toEqual({});
    expect(result.latency).toEqual({ count: 0, p50Ms: 0, p95Ms: 0 });
    expect(result.cost.totalCostUsd).toBe(0);
    expect(result.cost.costPerImageUsd).toBe(0);
    expect(result.cost.amortizedCostPerScoredImageUsd).toBe(0);
    expect(result.caveats).toEqual([]);
  });

  it('handles a single class (perfect and total miss)', () => {
    const perfect = scoreMetrics(
      [
        { id: 's1', labelKey: 'only' },
        { id: 's2', labelKey: 'only' },
      ],
      [
        { id: 's1', labelKey: 'only' },
        { id: 's2', labelKey: 'only' },
      ],
    );
    expect(perfect.perClass).toHaveLength(1);
    expect(perfect.perClass[0]?.precision).toBe(1);
    expect(perfect.perClass[0]?.recall).toBe(1);
    expect(perfect.perClass[0]?.f1).toBe(1);
    expect(perfect.macroF1).toBe(1);
    expect(perfect.balancedAccuracy).toBe(1);

    const missed = scoreMetrics(
      [
        { id: 's1', labelKey: 'only' },
        { id: 's2', labelKey: 'only' },
      ],
      [
        { id: 's1', labelKey: 'other' },
        { id: 's2', labelKey: 'other' },
      ],
    );
    expect(missed.perClass[0]?.precision).toBe(0);
    expect(missed.perClass[0]?.recall).toBe(0);
    expect(missed.perClass[0]?.f1).toBe(0);
    expect(missed.macroF1).toBe(0);
    expect(missed.balancedAccuracy).toBe(0);
  });

  it('scores a class that was never predicted as 0 by convention (zero division)', () => {
    const result = scoreMetrics(
      [
        { id: 'g1', labelKey: 'seen' },
        { id: 'g2', labelKey: 'never' },
      ],
      [
        { id: 'g1', labelKey: 'seen' },
        { id: 'g2', labelKey: 'seen' },
      ],
    );
    const never = result.perClass.find((entry) => entry.labelKey === 'never');
    expect(never).toBeDefined();
    // precision denominator is 0 → 0 (never NaN); recall 0 because there is no TP.
    expect(never?.precision).toBe(0);
    expect(never?.recall).toBe(0);
    expect(never?.f1).toBe(0);
    expect(never?.support).toBe(1);
    expect(Number.isNaN(result.macroF1)).toBe(false);
  });

  it('excludes a class below minSamples and reports it (never silently)', () => {
    const result = scoreMetrics(CONFUSION_GOLD, CONFUSION_PREDICTIONS, { minSamples: 3 });
    // C has 2 gold items < 3 → excluded from the per-class metrics.
    expect(result.perClass.map((entry) => entry.labelKey)).toEqual(['A', 'B']);
    expect(result.excludedClasses).toEqual([
      {
        labelKey: 'C',
        goldCount: 2,
        predictedCount: 1,
        reason: 'class has 2 gold item(s), below the minSamples threshold of 3',
      },
    ]);
    expect(result.caveats.join('\n')).toContain('Class "C"');
    expect(result.caveats.join('\n')).toContain('minSamples threshold of 3');
    // macro F1 and balanced accuracy now average the included classes only:
    // macro F1 = (0.5 + 0.5) / 2 = 0.5, balanced accuracy = 0.5.
    expect(result.macroF1).toBe(0.5);
    expect(result.balancedAccuracy).toBe(0.5);
    // The excluded class keeps its row in the confusion matrix — no hidden data.
    expect(result.confusion.rows['C']).toEqual({ A: 0, B: 0, C: 1, X: 1 });
  });

  it('counts a gold item without a prediction as a false negative and records a caveat', () => {
    const result = scoreMetrics(
      [
        { id: 'g1', labelKey: 'A' },
        { id: 'g2', labelKey: 'A' },
      ],
      [{ id: 'g1', labelKey: 'A' }],
    );
    expect(result.itemsScored).toBe(2);
    expect(result.correct).toBe(1);
    expect(result.perClass[0]?.truePositives).toBe(1);
    expect(result.perClass[0]?.falseNegatives).toBe(1);
    expect(result.perClass[0]?.recall).toBe(0.5);
    expect(result.caveats.join('\n')).toContain('1 gold item(s) had no prediction');
    // The missing prediction occupies no cell, so the row sum is support − 1.
    const rowSum = Object.values(result.confusion.rows['A'] ?? {}).reduce((a, b) => a + b, 0);
    expect(rowSum).toBe(1);
  });

  it('reports predictions that match no gold item instead of dropping them silently', () => {
    const result = scoreMetrics(
      [{ id: 'g1', labelKey: 'A' }],
      [
        { id: 'g1', labelKey: 'A' },
        { id: 'ghost', labelKey: 'A' },
      ],
    );
    expect(result.itemsScored).toBe(1);
    expect(result.caveats.join('\n')).toContain('1 prediction(s) match no gold item');
  });

  it('keeps the first occurrence of a duplicated id and reports the duplicate', () => {
    const result = scoreMetrics(
      [
        { id: 'g1', labelKey: 'A' },
        { id: 'g1', labelKey: 'A' },
      ],
      [
        { id: 'g1', labelKey: 'A' },
        { id: 'g1', labelKey: 'B' },
      ],
    );
    expect(result.itemsScored).toBe(1);
    expect(result.correct).toBe(1);
    expect(result.caveats.join('\n')).toContain('duplicate gold id(s)');
    expect(result.caveats.join('\n')).toContain('duplicate prediction id(s)');
  });

  it('carries the split on the gold item without letting it change the metrics', () => {
    const withSplit = scoreMetrics(
      [{ id: 'g1', labelKey: 'A', split: 'test' }],
      [{ id: 'g1', labelKey: 'A' }],
    );
    const withoutSplit = scoreMetrics([{ id: 'g1', labelKey: 'A' }], [{ id: 'g1', labelKey: 'A' }]);
    expect(withSplit.macroF1).toBe(withoutSplit.macroF1);
    expect(withSplit.balancedAccuracy).toBe(withoutSplit.balancedAccuracy);
  });
});

describe('benchmark metrics — latency percentiles (pinned method: linear interpolation)', () => {
  it('returns 0 for an empty list (never NaN)', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
    expect(computeLatencySummary([])).toEqual({ count: 0, p50Ms: 0, p95Ms: 0 });
  });

  it('returns the single value for a one-element list', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
    expect(
      computeLatencySummary([
        { id: 'a', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, latencyMs: 42 },
      ]),
    ).toEqual({
      count: 1,
      p50Ms: 42,
      p95Ms: 42,
    });
  });

  it('interpolates linearly between the two closest ranks', () => {
    // sorted [10, 20, 30, 40]
    //   p50: position = (4 - 1) * 0.5 = 1.5 → 20 + (30 - 20) * 0.5 = 25
    //   p95: position = (4 - 1) * 0.95 = 2.85 → 30 + (40 - 30) * 0.85 = 38.5
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(38.5);
  });

  it('ignores items without a latency and reports how many were timed', () => {
    const items: ScoredItem[] = [
      { id: 'a', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, latencyMs: 10 },
      { id: 'b', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true },
      { id: 'c', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, latencyMs: 20 },
    ];
    const summary = computeLatencySummary(items);
    expect(summary.count).toBe(2);
    expect(summary.p50Ms).toBe(15);
    expect(summary.p95Ms).toBe(19.5);
  });
});

describe('benchmark metrics — cost per image', () => {
  it('returns 0 when every image is free', () => {
    const items: ScoredItem[] = [
      { id: 'a', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0 },
      { id: 'b', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0 },
    ];
    const summary = computeCostSummary(items);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.costPerImageUsd).toBe(0);
    expect(summary.amortizedCostPerScoredImageUsd).toBe(0);
    expect(summary.itemsWithCost).toBe(2);
    expect(summary.itemsWithoutCost).toBe(0);
  });

  it('divides the total cost by the priced items and reports the unpriced ones', () => {
    const items: ScoredItem[] = [
      { id: 'a', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0.1 },
      { id: 'b', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0.3 },
      { id: 'c', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true },
    ];
    const summary = computeCostSummary(items);
    expect(summary.totalCostUsd).toBeCloseTo(0.4, 12);
    expect(summary.costPerImageUsd).toBeCloseTo(0.2, 12);
    expect(summary.amortizedCostPerScoredImageUsd).toBeCloseTo(0.4 / 3, 12);
    expect(summary.itemsWithCost).toBe(2);
    expect(summary.itemsWithoutCost).toBe(1);
  });

  it('derives a per-item cost from the repo pricing table (utils/cost lineage)', () => {
    // utils/cost.ts: openai gpt-4o → 2.5 USD / 1M input, 10 USD / 1M output.
    const cost = estimateItemCostUsd('openai', 1_000_000, 0);
    expect(cost).toBe(2.5);
    expect(estimateItemCostUsd('ollama', 1_000_000, 1_000_000)).toBe(0);
  });
});

describe('benchmark metrics — accuracy at budget (pinned ordering: cost asc, then id)', () => {
  const items: ScoredItem[] = [
    { id: 'b', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0.2 },
    { id: 'a', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0.2 },
    { id: 'c', goldLabelKey: 'A', predictedLabelKey: 'B', correct: false, costUsd: 0.1 },
    { id: 'd', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0.5 },
  ];

  it('returns 0 when the budget excludes every item', () => {
    const result = computeAccuracyAtBudget(items, 0.05);
    expect(result.itemsWithinBudget).toBe(0);
    expect(result.selectedItemIds).toEqual([]);
    expect(result.accuracy).toBe(0);
    expect(result.correct).toBe(0);
    expect(result.itemsExcluded).toBe(4);
    expect(result.budgetUsedUsd).toBe(0);
  });

  it('spends the budget in ascending cost order, breaking ties by item id', () => {
    const result = computeAccuracyAtBudget(items, 0.35);
    // order: c (0.1), a (0.2), b (0.2), d (0.5) → c and a fit (0.1 + 0.2 = 0.3 ≤ 0.35);
    // b would bring the total to 0.5 > 0.35, so it is skipped, and d never fits.
    expect(result.selectedItemIds).toEqual(['c', 'a']);
    expect(result.itemsWithinBudget).toBe(2);
    expect(result.budgetUsedUsd).toBeCloseTo(0.3, 12);
    // c is wrong, a is correct → 1 of 2.
    expect(result.correct).toBe(1);
    expect(result.accuracy).toBe(0.5);
  });

  it('breaks cost ties deterministically by item id', () => {
    const tied: ScoredItem[] = [
      { id: 'z', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0.1 },
      { id: 'y', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true, costUsd: 0.1 },
    ];
    expect(computeAccuracyAtBudget(tied, 0.1).selectedItemIds).toEqual(['y']);
  });

  it('does not select an item whose cost is unknown', () => {
    const unpriced: ScoredItem[] = [
      { id: 'x', goldLabelKey: 'A', predictedLabelKey: 'A', correct: true },
    ];
    const result = computeAccuracyAtBudget(unpriced, 10);
    expect(result.itemsWithinBudget).toBe(0);
    expect(result.itemsWithoutCost).toBe(1);
  });
});

describe('benchmark metrics — properties (seeded, deterministic)', () => {
  const SEED = 20261110;
  const RUNS = 200;

  it('keeps the confusion matrix row sums equal to the gold counts and macro F1 = mean of the per-class F1s', () => {
    const random = mulberry32(SEED);
    const classes = ['alpha', 'beta', 'gamma', 'delta'];
    const vocabulary = [...classes, 'unseen'];

    for (let run = 0; run < RUNS; run += 1) {
      const size = 1 + Math.floor(random() * 40);
      const gold: GoldItem[] = [];
      const predictions: PredictionItem[] = [];
      for (let index = 0; index < size; index += 1) {
        const id = `item-${String(index).padStart(3, '0')}`;
        const goldLabel = classes[Math.floor(random() * classes.length)] as string;
        gold.push({ id, labelKey: goldLabel });
        // Every gold item gets a prediction, so the row sums must match the counts.
        const predictedLabel = vocabulary[Math.floor(random() * vocabulary.length)] as string;
        predictions.push({ id, labelKey: predictedLabel });
      }

      const join = joinGoldAndPredictions(gold, predictions);
      const confusion = computeConfusionMatrix(join.items);
      const goldCounts = new Map<string, number>();
      for (const item of gold) {
        goldCounts.set(item.labelKey, (goldCounts.get(item.labelKey) ?? 0) + 1);
      }

      for (const [labelKey, count] of goldCounts) {
        const row = confusion.rows[labelKey] ?? {};
        const rowSum = Object.values(row).reduce((sum, value) => sum + value, 0);
        expect(rowSum).toBe(count);
      }

      const { perClass } = computePerClassMetrics(join.items);
      const mean = perClass.reduce((sum, entry) => sum + entry.f1, 0) / perClass.length;
      expect(computeMacroF1(perClass)).toBeCloseTo(mean, 12);
      const meanRecall = perClass.reduce((sum, entry) => sum + entry.recall, 0) / perClass.length;
      expect(computeBalancedAccuracy(perClass)).toBeCloseTo(meanRecall, 12);

      // Per-class P/R/F1 must be reproducible from the confusion matrix counts.
      for (const entry of perClass) {
        const row = confusion.rows[entry.labelKey] ?? {};
        const truePositives = row[entry.labelKey] ?? 0;
        expect(entry.truePositives).toBe(truePositives);
        const falsePositives = entry.predicted - truePositives;
        expect(entry.falsePositives).toBe(falsePositives);
        expect(entry.falseNegatives).toBe(entry.support - truePositives);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The non-finite inputs and the float boundaries.
//
// A reported metric that is `NaN` is worse than a missing one: it serialises
// as `null` in JSON and prints as "NaN ms" in Markdown, and neither reads as
// "no data".
// ---------------------------------------------------------------------------

describe('non-finite inputs are rejected, never reported', () => {
  const scored: ScoredItem[] = [
    {
      id: 'i01',
      goldLabelKey: 'A',
      predictedLabelKey: 'A',
      correct: true,
      probability: 0.9,
      latencyMs: Number.NaN,
      costUsd: 0.001,
    },
  ];

  it('rejects a non-finite latency', () => {
    expect(() => computeLatencySummary(scored)).toThrow(/non-finite latency/i);
  });

  it('rejects a non-finite cost', () => {
    expect(() =>
      computeCostSummary([
        { ...scored[0] as ScoredItem, latencyMs: 10, costUsd: Number.POSITIVE_INFINITY },
      ]),
    ).toThrow(/non-finite cost/i);
  });

  it('rejects a quantile outside [0, 1]', () => {
    expect(() => percentile([1, 2, 3], 2)).toThrow(/quantile/i);
    expect(() => percentile([1, 2, 3], -0.1)).toThrow(/quantile/i);
  });

  it('sorts its input defensively', () => {
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([2, 1, 3], 0.5)).toBe(2);
  });
});

describe('the budget boundary survives float accumulation', () => {
  const items: ScoredItem[] = [
    {
      id: 'x',
      goldLabelKey: 'A',
      predictedLabelKey: 'A',
      correct: true,
      costUsd: 0.1,
    },
    {
      id: 'y',
      goldLabelKey: 'A',
      predictedLabelKey: 'A',
      correct: true,
      costUsd: 0.2,
    },
  ];

  it('admits a 0.1 + 0.2 pair under a 0.3 budget', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    const result = computeAccuracyAtBudget(items, 0.3);
    expect(result.selectedItemIds).toEqual(['x', 'y']);
    expect(result.itemsWithinBudget).toBe(2);
  });

  it('excludes a pair that genuinely does not fit', () => {
    const result = computeAccuracyAtBudget(items, 0.25);
    expect(result.selectedItemIds).toEqual(['x']);
    expect(result.itemsWithinBudget).toBe(1);
  });
});
