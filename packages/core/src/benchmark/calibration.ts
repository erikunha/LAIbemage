/**
 * Expected Calibration Error (ECE) and reliability data for the 003 benchmark
 * runner (US3 / FR-004, plan.md → "ECE").
 *
 * Pure: the same input lists as `metrics.ts` (gold items + predictions) and
 * nothing else — no filesystem, no clock, no network, no randomness. The
 * shared input model is imported from `./metrics.js` instead of being
 * re-declared, so the metrics and the calibration can never drift apart on
 * what a "prediction" is.
 *
 * ## Pinned conventions
 *
 *  - **Bins** — 10 equal-width bins over [0, 1]. Bin `i` covers
 *    `[i/10, (i+1)/10)`; the last bin `[0.9, 1.0]` is closed at 1.0, so a
 *    confidence of exactly 1.0 lands in bin 9 and a confidence of exactly 0.0
 *    lands in bin 0. The bin index is `min(9, floor(p * 10))`.
 *  - **Formula** — `ECE = Σ (n_b / N) · |acc_b − conf_b|`, where `acc_b` is the
 *    fraction of correct predictions in the bin and `conf_b` their mean
 *    probability. Bins with `n_b = 0` contribute nothing.
 *  - **Out-of-range probabilities are rejected, not clamped** — a probability
 *    outside [0, 1] (or `NaN`) is a contract violation upstream
 *    (contracts → `PredictionSchema` bounds `probabilityRaw` to [0, 1]).
 *    Clamping it would silently fabricate a calibration number; the input is
 *    rejected with an error naming the item id and the offending value.
 *  - **Empty input** — no item with a probability yields `ece: 0` and bins
 *    with `count: 0` (never `NaN`).
 */

import {
  joinGoldAndPredictions,
  type GoldItem,
  type PredictionItem,
  type ScoredItem,
} from './metrics.js';

/** Number of equal-width confidence bins used by the ECE. */
export const CALIBRATION_BIN_COUNT = 10;

/** One reliability bin. */
export interface CalibrationBin {
  /** Bin index, 0 (lowest confidence) … 9 (highest). */
  readonly index: number;
  /** Inclusive lower edge of the bin. */
  readonly lower: number;
  /** Exclusive upper edge of the bin — except for the last bin, which is closed. */
  readonly upper: number;
  /** Number of items in the bin. */
  readonly count: number;
  /** Mean probability of the items in the bin (0 for an empty bin). */
  readonly meanConfidence: number;
  /** Fraction of correct items in the bin (0 for an empty bin). */
  readonly accuracy: number;
}

/** The calibration report of one scoring run. */
export interface CalibrationResult {
  /** Items that carried a probability and were binned. */
  readonly itemsScored: number;
  /** Scored items without a probability (excluded from the ECE). */
  readonly itemsWithoutProbability: number;
  /** Expected calibration error over the 10 bins (0 for an empty input). */
  readonly ece: number;
  /** Reliability data, one entry per bin, in ascending bin order. */
  readonly bins: readonly CalibrationBin[];
}

/**
 * Bin index of a confidence value.
 *
 * `min(CALIBRATION_BIN_COUNT - 1, floor(p * CALIBRATION_BIN_COUNT))`:
 * `p = 0` → bin 0, `p = 1` → bin 9 (the last bin is closed at 1.0).
 */
export function confidenceBinIndex(probability: number): number {
  const index = Math.floor(probability * CALIBRATION_BIN_COUNT);
  if (index < 0) return 0;
  if (index > CALIBRATION_BIN_COUNT - 1) return CALIBRATION_BIN_COUNT - 1;
  return index;
}

/**
 * Reject a probability that is outside [0, 1] (or `NaN`).
 *
 * Clamping is deliberately not offered: a clamped value would produce a
 * perfectly plausible-looking ECE for a broken input, which is exactly the
 * kind of "hypothesis presented as a result" the constitution forbids.
 */
function assertValidProbability(itemId: string, probability: number): void {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError(
      `Prediction "${itemId}" has an invalid probability ${String(probability)}; ` +
        'expected a finite number in [0, 1].',
    );
  }
}

/**
 * Expected Calibration Error and reliability data over 10 equal-width bins.
 *
 * Conventions are documented at the top of this file. In short: 10 bins over
 * [0, 1], half-open except for the closed last bin, `ECE = Σ (n_b/N)·|acc_b −
 * conf_b|`, out-of-range probabilities rejected, empty input → `ece: 0`.
 *
 * @param gold Gold items (the join key is the item id).
 * @param predictions Model predictions; only the ones carrying a probability
 *   are binned.
 */
export function computeCalibration(
  gold: readonly GoldItem[],
  predictions: readonly PredictionItem[],
): CalibrationResult {
  const join = joinGoldAndPredictions(gold, predictions);
  const scored = join.items;

  const binned: ScoredItem[] = [];
  let itemsWithoutProbability = 0;
  for (const item of scored) {
    if (item.probability === undefined) {
      itemsWithoutProbability += 1;
      continue;
    }
    assertValidProbability(item.id, item.probability);
    binned.push(item);
  }

  const counts = new Array<number>(CALIBRATION_BIN_COUNT).fill(0);
  const confidenceSums = new Array<number>(CALIBRATION_BIN_COUNT).fill(0);
  const correctCounts = new Array<number>(CALIBRATION_BIN_COUNT).fill(0);

  for (const item of binned) {
    const probability = item.probability ?? 0;
    const index = confidenceBinIndex(probability);
    counts[index] += 1;
    confidenceSums[index] += probability;
    if (item.correct) correctCounts[index] += 1;
  }

  const total = binned.length;
  const bins: CalibrationBin[] = [];
  let ece = 0;
  for (let index = 0; index < CALIBRATION_BIN_COUNT; index += 1) {
    const count = counts[index] ?? 0;
    const lower = index / CALIBRATION_BIN_COUNT;
    const upper = (index + 1) / CALIBRATION_BIN_COUNT;
    const meanConfidence = count > 0 ? (confidenceSums[index] ?? 0) / count : 0;
    const accuracy = count > 0 ? (correctCounts[index] ?? 0) / count : 0;
    if (count > 0 && total > 0) {
      ece += (count / total) * Math.abs(accuracy - meanConfidence);
    }
    bins.push({ index, lower, upper, count, meanConfidence, accuracy });
  }

  return {
    itemsScored: total,
    itemsWithoutProbability,
    ece,
    bins,
  };
}
