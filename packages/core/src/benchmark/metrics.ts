/**
 * Pure metrics core for the 003 benchmark runner (US3 / FR-004).
 *
 * Everything here is a pure function over two input lists (`GoldItem[]` and
 * `PredictionItem[]`): no filesystem, no clock, no network, no randomness.
 * `runner.ts` owns I/O, the reproduction tuple and artifact emission; specs
 * 006/007 call these very same functions so no ad-hoc metric code path can
 * drift (plan.md → "Runner purity").
 *
 * ## Conventions are pinned, not implied
 *
 * Two metric numbers are only comparable when the conventions behind them are
 * identical, so every convention a reader could reasonably get wrong is fixed
 * here and repeated in the docblock of the function that applies it:
 *
 *  - **Zero division** — precision, recall and F1 of a class whose denominator
 *    is zero (no prediction for it, or no gold occurrence) are `0`, never `NaN`.
 *  - **Unseen predicted labels** — a prediction whose label is not in the gold
 *    vocabulary is an error: it counts as wrong, it appears in the confusion
 *    matrix as an extra column, and it is listed in `unseenPredictedLabels`.
 *    It is never silently dropped.
 *  - **Missing predictions** — a gold item with no prediction is a false
 *    negative for its class (it is not in the confusion matrix, so the row sum
 *    is lower than the class support by exactly the number of missing
 *    predictions for that class).
 *  - **Percentiles** — linear interpolation between the two closest ranks
 *    (the "type 7" / NumPy default) over the ascending-sorted values.
 *  - **Budget ordering** — items are ordered by ascending cost, ties broken by
 *    ascending item id, and the budget is spent greedily in that order.
 *  - **Determinism** — every returned collection is sorted with a
 *    locale-independent comparison, so two runs over the same input serialize
 *    byte-identically.
 *
 * ## Vocabulary
 *
 * Field names follow the 002 contracts (`Prediction.labelKey`,
 * `Prediction.probabilityRaw`, `Prediction.latencyMs`,
 * `Prediction.costMicroUsd`): a class label is a `labelKey`. `probability` here
 * is expected to be the **calibrated** probability (constitution V: a
 * self-declared confidence is never treated as a probability).
 */

import { PROVIDER_PRICING } from '../utils/cost.js';

// ---------------------------------------------------------------------------
// Input model — shared with calibration.ts (single source of truth)
// ---------------------------------------------------------------------------

/** A gold (ground-truth) item: one image with its human-authored class label. */
export interface GoldItem {
  /** Stable item id; the join key against {@link PredictionItem.id}. */
  readonly id: string;
  /** Gold class label (the 002-contract vocabulary: a `labelKey`). */
  readonly labelKey: string;
  /** Split the item belongs to; carried for the caller's grouping, not scored here. */
  readonly split?: string;
}

/** A model-produced prediction for one gold item. */
export interface PredictionItem {
  /** The gold item id this prediction answers. */
  readonly id: string;
  /** Predicted class label (a `labelKey`; may be outside the gold vocabulary). */
  readonly labelKey: string;
  /** Calibrated probability of the predicted label, in [0, 1]. */
  readonly probability?: number;
  /** Wall-clock latency of the prediction, in milliseconds. */
  readonly latencyMs?: number;
  /** Cost of the prediction, in USD. */
  readonly costUsd?: number;
}

/** One gold item joined with its prediction (or with its absence). */
export interface ScoredItem {
  readonly id: string;
  readonly goldLabelKey: string;
  /** `null` when the gold item had no prediction (counted as a false negative). */
  readonly predictedLabelKey: string | null;
  readonly correct: boolean;
  readonly probability?: number;
  readonly latencyMs?: number;
  readonly costUsd?: number;
}

/** Outcome of joining gold items with predictions. */
export interface JoinResult {
  /** Scored items, sorted by item id. */
  readonly items: readonly ScoredItem[];
  /** Gold items without any prediction (counted as false negatives). */
  readonly goldWithoutPrediction: number;
  /** Predictions whose id matches no gold item (not scorable, never dropped silently). */
  readonly predictionsWithoutGold: number;
  /** Duplicate gold ids; the first occurrence in input order wins. */
  readonly duplicateGoldIds: number;
  /** Duplicate prediction ids; the first occurrence in input order wins. */
  readonly duplicatePredictionIds: number;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** Per-class precision / recall / F1 over the classes included in the metrics. */
export interface ClassMetrics {
  readonly labelKey: string;
  /** Gold occurrences of the class (the support). */
  readonly support: number;
  /** Times the class was predicted (including predictions of other classes' items). */
  readonly predicted: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

/** A class excluded from the per-class metrics by the `minSamples` threshold. */
export interface ExcludedClass {
  readonly labelKey: string;
  readonly goldCount: number;
  readonly predictedCount: number;
  readonly reason: string;
}

/** Gold class × predicted class counts. `labels` is the canonical column order. */
export interface ConfusionMatrix {
  /** Sorted union of the gold classes and the observed predicted labels. */
  readonly labels: readonly string[];
  /** Row-major counts: `rows[goldLabel][predictedLabel]`. */
  readonly rows: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** A predicted label that is not part of the gold vocabulary. */
export interface UnseenPredictedLabel {
  readonly labelKey: string;
  readonly count: number;
}

/** Latency percentiles over the items that carry a latency. */
export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

/** Cost roll-up over the items that carry a cost. */
export interface CostSummary {
  /** Sum of the recorded costs. */
  readonly totalCostUsd: number;
  /** `totalCostUsd / itemsWithCost` — the cost of one **priced** image. */
  readonly costPerImageUsd: number;
  /** `totalCostUsd / scoredItems` — the cost amortized over every scored image. */
  readonly amortizedCostPerScoredImageUsd: number;
  readonly itemsWithCost: number;
  readonly itemsWithoutCost: number;
}

/** Accuracy reached within a total cost budget. */
export interface BudgetResult {
  readonly budgetUsd: number;
  /** Items selected under the budget (sorted by cost ascending, then id). */
  readonly selectedItemIds: readonly string[];
  readonly itemsWithinBudget: number;
  readonly itemsExcluded: number;
  /** Scored items without a recorded cost (unknown cost → not selectable). */
  readonly itemsWithoutCost: number;
  /** Total cost of the selected items. */
  readonly budgetUsedUsd: number;
  readonly correct: number;
  /** `correct / itemsWithinBudget`; `0` when nothing fits the budget. */
  readonly accuracy: number;
}

/** Options of {@link scoreMetrics}. */
export interface MetricsOptions {
  /**
   * Minimum number of gold items a class needs to be scored. Classes below the
   * threshold are excluded from the per-class metrics, from the macro F1 and
   * from the balanced accuracy, and are returned in `excludedClasses` so the
   * caller can record the caveat. The spec's threshold is 30; the default is 1
   * (no exclusion) so the caller decides explicitly.
   */
  readonly minSamples?: number;
}

/** The complete metric set of one scoring run. */
export interface MetricsResult {
  /** Number of gold items scored (one per distinct gold id). */
  readonly itemsScored: number;
  readonly correct: number;
  /** Overall accuracy; reported for completeness, never as the headline number. */
  readonly accuracy: number;
  /** Per-class metrics, sorted by class label. */
  readonly perClass: readonly ClassMetrics[];
  /** Unweighted mean of the per-class F1 values over the included classes. */
  readonly macroF1: number;
  /** Unweighted mean of the per-class recall values over the included classes. */
  readonly balancedAccuracy: number;
  readonly confusion: ConfusionMatrix;
  /** Predicted labels outside the gold vocabulary, sorted by label. */
  readonly unseenPredictedLabels: readonly UnseenPredictedLabel[];
  /** Classes excluded by `minSamples`, sorted by class label. */
  readonly excludedClasses: readonly ExcludedClass[];
  /** Human-readable caveats the report must carry (never a silent exclusion). */
  readonly caveats: readonly string[];
  readonly latency: LatencySummary;
  readonly cost: CostSummary;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Locale-independent string comparison. `Array.prototype.sort` without a
 * comparator would use the runtime locale, which is not reproducible across
 * machines; codepoint order is.
 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * The slack the budget comparison gets, in USD.
 *
 * Costs are floats, so a budget of 0.3 USD must still admit a 0.1 + 0.2 pair
 * whose sum is 0.30000000000000004 in binary floating point. The slack is a
 * hundredth of a cent — far below any real per-image cost, and large enough
 * to absorb the rounding of a handful of additions.
 */
export const BUDGET_EPSILON_USD = 1e-6;

/**
 * Linear-interpolation percentile over ascending-sorted values.
 *
 * Pinned method: linear interpolation between the two closest ranks (the
 * "type 7" definition used by NumPy and by most monitoring tools). The
 * nearest-rank method would return an observed value instead of an interpolated
 * one, and the two disagree often enough that mixing them makes two reports
 * incomparable — so the method is fixed here, once.
 *
 * The function sorts its input defensively: a caller that hands over unsorted
 * values gets the same answer as one that sorts them first.
 *
 * @param values The values. Sorted ascending internally.
 * @param q Quantile in [0, 1] (0.5 → p50, 0.95 → p95).
 * @returns The percentile; `0` for an empty input (never `NaN`).
 * @throws RangeError when `q` is outside [0, 1] — an out-of-range quantile
 *   would otherwise return `undefined` and poison a reported number.
 */
export function percentile(values: readonly number[], q: number): number {
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new RangeError(`the quantile must be a number in [0, 1], got ${String(q)}`);
  }
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] as number;
  return (
    (sorted[lower] as number) +
    ((sorted[upper] as number) - (sorted[lower] as number)) * (position - lower)
  );
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

/**
 * Join gold items with their predictions by id.
 *
 * Conventions: the first occurrence of a duplicated id wins (the duplicate
 * count is reported so the caller can record it); a gold item without a
 * prediction becomes a false negative; a prediction without a gold item is not
 * scorable and is reported, never dropped silently.
 */
export function joinGoldAndPredictions(
  gold: readonly GoldItem[],
  predictions: readonly PredictionItem[],
): JoinResult {
  const goldById = new Map<string, GoldItem>();
  let duplicateGoldIds = 0;
  for (const item of gold) {
    if (goldById.has(item.id)) {
      duplicateGoldIds += 1;
      continue;
    }
    goldById.set(item.id, item);
  }

  const predictionById = new Map<string, PredictionItem>();
  let duplicatePredictionIds = 0;
  for (const item of predictions) {
    if (predictionById.has(item.id)) {
      duplicatePredictionIds += 1;
      continue;
    }
    predictionById.set(item.id, item);
  }

  const items: ScoredItem[] = [];
  let goldWithoutPrediction = 0;

  for (const g of goldById.values()) {
    const prediction = predictionById.get(g.id);
    if (prediction === undefined) {
      goldWithoutPrediction += 1;
      items.push({
        id: g.id,
        goldLabelKey: g.labelKey,
        predictedLabelKey: null,
        correct: false,
      });
      continue;
    }
    items.push({
      id: g.id,
      goldLabelKey: g.labelKey,
      predictedLabelKey: prediction.labelKey,
      correct: prediction.labelKey === g.labelKey,
      probability: prediction.probability,
      latencyMs: prediction.latencyMs,
      costUsd: prediction.costUsd,
    });
  }

  let predictionsWithoutGold = 0;
  for (const prediction of predictionById.values()) {
    if (!goldById.has(prediction.id)) predictionsWithoutGold += 1;
  }

  items.sort((a, b) => compareStrings(a.id, b.id));

  return {
    items,
    goldWithoutPrediction,
    predictionsWithoutGold,
    duplicateGoldIds,
    duplicatePredictionIds,
  };
}

// ---------------------------------------------------------------------------
// Per-class metrics
// ---------------------------------------------------------------------------

interface ClassTally {
  gold: number;
  predicted: number;
  truePositives: number;
}

/**
 * Per-class precision / recall / F1 for every class of the gold vocabulary.
 *
 * Pinned conventions:
 *  - The class set is the **gold vocabulary** (the classes present in the gold
 *    set), so a class that is never predicted still gets a row — hiding it
 *    would make a broken classifier look better than a broken dataset.
 *  - `precision = TP / (TP + FP)`; `recall = TP / support`; `F1 = 2PR/(P+R)`.
 *    A zero denominator yields `0` (never `NaN`): a class that was never
 *    predicted has precision 0 by convention, and a class with no gold
 *    occurrence has recall 0 by convention.
 *  - `FP` counts only scorable items (a prediction whose id matches no gold
 *    item is reported separately and never inflates a class's FP).
 *  - Classes below `minSamples` are excluded from this list and returned in
 *    `excludedClasses` — excluded loudly, never silently.
 */
export function computePerClassMetrics(
  items: readonly ScoredItem[],
  minSamples = 1,
): {
  readonly perClass: readonly ClassMetrics[];
  readonly excludedClasses: readonly ExcludedClass[];
} {
  const tallies = new Map<string, ClassTally>();
  const tallyOf = (labelKey: string): ClassTally => {
    let tally = tallies.get(labelKey);
    if (tally === undefined) {
      tally = { gold: 0, predicted: 0, truePositives: 0 };
      tallies.set(labelKey, tally);
    }
    return tally;
  };

  for (const item of items) {
    tallyOf(item.goldLabelKey).gold += 1;
    if (item.predictedLabelKey !== null) {
      const predictedTally = tallyOf(item.predictedLabelKey);
      predictedTally.predicted += 1;
      if (item.predictedLabelKey === item.goldLabelKey) {
        predictedTally.truePositives += 1;
      }
    }
  }

  const perClass: ClassMetrics[] = [];
  const excludedClasses: ExcludedClass[] = [];

  for (const labelKey of sortedUnique(items.map((item) => item.goldLabelKey))) {
    const tally = tallyOf(labelKey);
    const falsePositives = tally.predicted - tally.truePositives;
    const falseNegatives = tally.gold - tally.truePositives;

    if (tally.gold < minSamples) {
      excludedClasses.push({
        labelKey,
        goldCount: tally.gold,
        predictedCount: tally.predicted,
        reason: `class has ${tally.gold} gold item(s), below the minSamples threshold of ${minSamples}`,
      });
      continue;
    }

    const precision =
      tally.truePositives + falsePositives > 0
        ? tally.truePositives / (tally.truePositives + falsePositives)
        : 0;
    const recall = tally.gold > 0 ? tally.truePositives / tally.gold : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    perClass.push({
      labelKey,
      support: tally.gold,
      predicted: tally.predicted,
      truePositives: tally.truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1,
    });
  }

  return { perClass, excludedClasses };
}

/**
 * Macro F1: the unweighted mean of the per-class F1 values.
 *
 * Unweighted on purpose — a normal-heavy dataset (VisA) would otherwise let
 * the dominant class decide the score.
 */
export function computeMacroF1(perClass: readonly ClassMetrics[]): number {
  if (perClass.length === 0) return 0;
  const total = perClass.reduce((sum, metrics) => sum + metrics.f1, 0);
  return total / perClass.length;
}

/**
 * Balanced accuracy: the unweighted mean of the per-class recall values.
 *
 * Reported because the dataset is normal-heavy: plain accuracy would mostly
 * measure how often the model says "normal".
 */
export function computeBalancedAccuracy(perClass: readonly ClassMetrics[]): number {
  if (perClass.length === 0) return 0;
  const total = perClass.reduce((sum, metrics) => sum + metrics.recall, 0);
  return total / perClass.length;
}

/**
 * Confusion matrix (gold class × predicted class).
 *
 * Pinned conventions:
 *  - Rows are the gold classes, columns are the sorted union of the gold
 *    classes and the observed predicted labels.
 *  - A predicted label outside the gold vocabulary is **not** dropped: it gets
 *    its own column (so the error is visible in the matrix) and is listed in
 *    `unseenPredictedLabels`.
 *  - A gold item without a prediction contributes to no cell, so a row sum is
 *    the class support minus the number of its missing predictions.
 */
export function computeConfusionMatrix(items: readonly ScoredItem[]): ConfusionMatrix {
  const goldLabels = sortedUnique(items.map((item) => item.goldLabelKey));
  const predictedLabels = sortedUnique(
    items
      .map((item) => item.predictedLabelKey)
      .filter((labelKey): labelKey is string => labelKey !== null),
  );
  const labels = sortedUnique([...goldLabels, ...predictedLabels]);

  const rows: Record<string, Record<string, number>> = {};
  for (const goldLabel of goldLabels) {
    const row: Record<string, number> = {};
    for (const predictedLabel of labels) row[predictedLabel] = 0;
    rows[goldLabel] = row;
  }

  for (const item of items) {
    if (item.predictedLabelKey === null) continue;
    const row = rows[item.goldLabelKey];
    if (row === undefined) continue;
    row[item.predictedLabelKey] = (row[item.predictedLabelKey] ?? 0) + 1;
  }

  return { labels, rows };
}

/**
 * Predicted labels that are not part of the gold vocabulary, with their
 * counts. These are errors: they count as wrong and they are never dropped.
 */
export function computeUnseenPredictedLabels(items: readonly ScoredItem[]): UnseenPredictedLabel[] {
  const goldLabels = new Set(items.map((item) => item.goldLabelKey));
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.predictedLabelKey === null) continue;
    if (goldLabels.has(item.predictedLabelKey)) continue;
    counts.set(item.predictedLabelKey, (counts.get(item.predictedLabelKey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([labelKey, count]) => ({ labelKey, count }))
    .sort((a, b) => compareStrings(a.labelKey, b.labelKey));
}

// ---------------------------------------------------------------------------
// Latency / cost / budget
// ---------------------------------------------------------------------------

/**
 * Latency percentiles p50 / p95 over the items that carry a latency.
 *
 * Pinned method: linear interpolation between the two closest ranks (type 7).
 * An empty input yields `0` (never `NaN`); a single value yields that value
 * for both percentiles.
 */
export function computeLatencySummary(items: readonly ScoredItem[]): LatencySummary {
  const latencies: number[] = [];
  for (const item of items) {
    if (item.latencyMs === undefined) continue;
    if (!Number.isFinite(item.latencyMs)) {
      throw new RangeError(
        `Prediction "${item.id}" has a non-finite latency (${String(item.latencyMs)}); ` +
          'expected a finite number of milliseconds.',
      );
    }
    latencies.push(item.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  return {
    count: latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  };
}

/**
 * Cost roll-up over the items that carry a cost.
 *
 * Pinned conventions:
 *  - Items **without** a recorded cost are excluded from the denominator of
 *    `costPerImageUsd` (an unpriced item is not a free item) and their count
 *    is reported as `itemsWithoutCost` so the report can flag the caveat.
 *  - `amortizedCostPerScoredImageUsd` spreads the same total over every scored
 *    image, priced or not.
 *  - No scoring image yields `0` (never `NaN`).
 */
export function computeCostSummary(items: readonly ScoredItem[]): CostSummary {
  let totalCostUsd = 0;
  let itemsWithCost = 0;
  for (const item of items) {
    if (item.costUsd === undefined) continue;
    if (!Number.isFinite(item.costUsd)) {
      throw new RangeError(
        `Prediction "${item.id}" has a non-finite cost (${String(item.costUsd)}); ` +
          'expected a finite amount in USD.',
      );
    }
    totalCostUsd += item.costUsd;
    itemsWithCost += 1;
  }
  const itemsWithoutCost = items.length - itemsWithCost;
  return {
    totalCostUsd,
    costPerImageUsd: itemsWithCost > 0 ? totalCostUsd / itemsWithCost : 0,
    amortizedCostPerScoredImageUsd: items.length > 0 ? totalCostUsd / items.length : 0,
    itemsWithCost,
    itemsWithoutCost,
  };
}

/**
 * Accuracy reached within a total cost budget.
 *
 * Pinned conventions:
 *  - The budget is a **total** cost ceiling in USD (not a per-item cap).
 *  - Items are ordered by ascending cost, ties broken by ascending item id,
 *    and the budget is spent greedily in that order: the selected set is the
 *    longest prefix whose total cost fits the budget. The ordering is pinned
 *    because a different order would select different items and therefore a
 *    different accuracy.
 *  - `accuracy = correct / itemsWithinBudget`; an empty selection yields `0`
 *    (never `NaN`) — the report shows `itemsWithinBudget: 0` next to it.
 *  - An item without a recorded cost cannot be proven to fit the budget, so it
 *    is not selectable; the count is reported as `itemsWithoutCost`.
 */
export function computeAccuracyAtBudget(
  items: readonly ScoredItem[],
  budgetUsd: number,
): BudgetResult {
  const affordable = items.filter((item) => item.costUsd !== undefined);
  const itemsWithoutCost = items.length - affordable.length;
  const ordered = [...affordable].sort((a, b) => {
    const costDelta = (a.costUsd ?? 0) - (b.costUsd ?? 0);
    if (costDelta !== 0) return costDelta;
    return compareStrings(a.id, b.id);
  });

  const selectedItemIds: string[] = [];
  let budgetUsedUsd = 0;
  let correct = 0;
  for (const item of ordered) {
    const cost = item.costUsd ?? 0;
    // The comparison carries a slack, because USD costs are floats: a budget
    // of 0.3 must still admit a 0.1 + 0.2 pair, whose sum is
    // 0.30000000000000004 in binary floating point. Without the slack the
    // longest prefix that "fits" would depend on the rounding of the sum.
    if (budgetUsedUsd + cost - budgetUsd > BUDGET_EPSILON_USD) continue;
    budgetUsedUsd += cost;
    selectedItemIds.push(item.id);
    if (item.correct) correct += 1;
  }

  return {
    budgetUsd,
    selectedItemIds,
    itemsWithinBudget: selectedItemIds.length,
    itemsExcluded: items.length - selectedItemIds.length,
    itemsWithoutCost,
    budgetUsedUsd,
    correct,
    accuracy: selectedItemIds.length > 0 ? correct / selectedItemIds.length : 0,
  };
}

/**
 * Derive a per-item cost from the repo's provider pricing.
 *
 * The pricing table is **not** duplicated here: it is imported from
 * `utils/cost.ts` (the single source maintained with the providers), so the
 * benchmark can never quote a price the CLI does not use.
 */
export function estimateItemCostUsd(
  provider: keyof typeof PROVIDER_PRICING,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PROVIDER_PRICING[provider];
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

// ---------------------------------------------------------------------------
// Top-level scoring
// ---------------------------------------------------------------------------

/**
 * Score a set of predictions against a set of gold labels.
 *
 * Pure: same inputs → same output, byte for byte. Every collection in the
 * result is sorted, and the caveats list records everything that could
 * otherwise make the numbers look better than they are (excluded classes,
 * missing predictions, unpriced items, duplicates).
 */
export function scoreMetrics(
  gold: readonly GoldItem[],
  predictions: readonly PredictionItem[],
  options: MetricsOptions = {},
): MetricsResult {
  const minSamples = options.minSamples ?? 1;
  const join = joinGoldAndPredictions(gold, predictions);
  const items = join.items;

  const { perClass, excludedClasses } = computePerClassMetrics(items, minSamples);
  const confusion = computeConfusionMatrix(items);
  const unseenPredictedLabels = computeUnseenPredictedLabels(items);
  const latency = computeLatencySummary(items);
  const cost = computeCostSummary(items);

  const correct = items.filter((item) => item.correct).length;
  const caveats: string[] = [];

  for (const excluded of excludedClasses) {
    caveats.push(
      `Class "${excluded.labelKey}" ${excluded.reason} and is excluded from the per-class metrics, ` +
        'the macro F1 and the balanced accuracy.',
    );
  }
  if (join.goldWithoutPrediction > 0) {
    caveats.push(
      `${join.goldWithoutPrediction} gold item(s) had no prediction and count as false negatives.`,
    );
  }
  if (join.predictionsWithoutGold > 0) {
    caveats.push(
      `${join.predictionsWithoutGold} prediction(s) match no gold item and are not scored.`,
    );
  }
  if (join.duplicateGoldIds > 0) {
    caveats.push(
      `${join.duplicateGoldIds} duplicate gold id(s) were ignored (first occurrence wins).`,
    );
  }
  if (join.duplicatePredictionIds > 0) {
    caveats.push(
      `${join.duplicatePredictionIds} duplicate prediction id(s) were ignored (first occurrence wins).`,
    );
  }
  if (cost.itemsWithoutCost > 0) {
    caveats.push(
      `${cost.itemsWithoutCost} scored item(s) carry no cost; the cost per image is computed ` +
        `over the ${cost.itemsWithCost} priced item(s).`,
    );
  }
  const itemsWithoutLatency = items.length - latency.count;
  if (itemsWithoutLatency > 0) {
    caveats.push(
      `${itemsWithoutLatency} scored item(s) carry no latency; the percentiles are computed ` +
        `over the ${latency.count} timed item(s).`,
    );
  }

  return {
    itemsScored: items.length,
    correct,
    accuracy: items.length > 0 ? correct / items.length : 0,
    perClass,
    macroF1: computeMacroF1(perClass),
    balancedAccuracy: computeBalancedAccuracy(perClass),
    confusion,
    unseenPredictedLabels,
    excludedClasses,
    caveats,
    latency,
    cost,
  };
}
