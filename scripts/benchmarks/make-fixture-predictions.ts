/**
 * Fixture predictions generator — spec 003, US4 (task 4.2).
 *
 * Produces a deterministic prediction file for the synthetic fixture dataset,
 * so the whole benchmark flow (split → score → artifact → gate) can be
 * exercised without VisA and without a model provider.
 *
 * ## Why a generator instead of a checked-in file
 *
 * A checked-in prediction file would be a second source of truth that could
 * drift from the split manifest. This generator derives the predictions FROM
 * the manifest, so the two can never disagree, and the planted regression is
 * a parameter rather than a binary blob nobody can diff.
 *
 * ## The planted regression
 *
 * `--flip <fraction>` turns that fraction of the predictions into wrong ones.
 * The subset is chosen with a seeded PRNG (mulberry32 — never `Math.random`),
 * so the SAME seed always flips the SAME items: the gate regression is
 * reproducible instead of flaky.
 *
 * Usage:
 *   pnpm exec tsx scripts/benchmarks/make-fixture-predictions.ts \
 *     --split benchmarks/splits/synthetic-30.gold.json \
 *     --out benchmarks/fixtures/predictions.json
 *
 *   # the same, with a planted 10% regression:
 *   pnpm exec tsx scripts/benchmarks/make-fixture-predictions.ts \
 *     --split benchmarks/splits/synthetic-30.gold.json \
 *     --out benchmarks/fixtures/predictions-regressed.json --flip 0.1
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { mulberry32, type SplitAssignment, type SplitManifest } from '../../packages/core/src/benchmark/splits.js';

/** The label key an assignment is scored under — the same rule the CLI uses. */
function labelKeyOf(assignment: SplitAssignment): string {
  return assignment.anomaly === 'normal' ? 'normal' : `defect:${assignment.class}`;
}

/** The label key a WRONG prediction gets: another class of the same vocabulary. */
function wrongLabelKeyOf(assignment: SplitAssignment, vocabulary: readonly string[]): string {
  const correct = labelKeyOf(assignment);
  const alternatives = vocabulary.filter((label) => label !== correct);
  if (alternatives.length === 0) return correct;
  // Deterministic: the first alternative that is not the correct label.
  return alternatives[0] as string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      split: { type: 'string', default: 'benchmarks/splits/synthetic-30.gold.json' },
      out: { type: 'string', default: 'benchmarks/fixtures/predictions.json' },
      seed: { type: 'string', default: '20261110' },
      flip: { type: 'string', default: '0' },
      errorRate: { type: 'string', default: '0.1' },
    },
  });

  const manifest = JSON.parse(
    await readFile(values.split as string, 'utf8'),
  ) as SplitManifest;

  const flip = Number.parseFloat(values.flip as string);
  const errorRate = Number.parseFloat(values.errorRate as string);
  if (!Number.isFinite(flip) || flip < 0 || flip > 1) {
    throw new Error(`--flip must be a fraction between 0 and 1, got ${String(values.flip)}`);
  }
  if (!Number.isFinite(errorRate) || errorRate < 0 || errorRate > 1) {
    throw new Error(
      `--error-rate must be a fraction between 0 and 1, got ${String(values.errorRate)}`,
    );
  }

  const vocabulary = [...new Set(manifest.assignments.map(labelKeyOf))].sort();
  const seed = Number.parseInt(values.seed as string, 10);

  // TWO INDEPENDENT streams, on purpose.
  //
  // The baseline errors and the planted regression are drawn from different
  // PRNGs, and the flipped items are chosen among the items that are CORRECT
  // in the baseline. Without that, flipping an item shifts the shared random
  // stream and the "regression" is not a controlled delta — it is a different
  // run with a different error set, and the measured drop says nothing about
  // the flip. With it, the regressed run differs from the baseline by exactly
  // the flipped items.
  const errorRandom = mulberry32(seed);
  const flipRandom = mulberry32(seed ^ 0x9e3779b9);

  const errorItems = new Set<string>();
  for (const assignment of manifest.assignments) {
    if (errorRandom() < errorRate) errorItems.add(assignment.id);
  }

  const correctItems = manifest.assignments
    .map((assignment) => assignment.id)
    .filter((id) => !errorItems.has(id));
  const flipCount = Math.min(
    Math.round(manifest.assignments.length * flip),
    correctItems.length,
  );
  const flipped = new Set<string>();
  while (flipped.size < flipCount) {
    const candidate = correctItems[Math.floor(flipRandom() * correctItems.length)];
    if (candidate !== undefined) flipped.add(candidate);
  }

  const predictions = manifest.assignments.map((assignment, index) => {
    const correct = labelKeyOf(assignment);
    // Every prediction carries a small, deterministic error so the metrics are
    // not degenerate: a perfect run proves nothing about the pipeline.
    const shouldBeWrong = errorItems.has(assignment.id) || flipped.has(assignment.id);
    const labelKey = shouldBeWrong ? wrongLabelKeyOf(assignment, vocabulary) : correct;
    const isCorrect = labelKey === correct;
    return {
      id: assignment.id,
      labelKey,
      probability: isCorrect ? 0.85 : 0.35,
      latencyMs: 120 + ((index * 7) % 80),
      costUsd: 0.0004,
    };
  });

  await mkdir(path.dirname(path.resolve(values.out as string)), { recursive: true });
  await writeFile(
    values.out as string,
    `${JSON.stringify(predictions, null, 2)}\n`,
    'utf8',
  );

  const wrong = predictions.filter(
    (prediction) =>
      prediction.labelKey !==
      labelKeyOf(
        manifest.assignments.find((assignment) => assignment.id === prediction.id) as SplitAssignment,
      ),
  ).length;

  process.stdout.write(
    `[fixture-predictions] ${predictions.length} predictions → ${values.out as string} ` +
      `(${wrong} wrong: ${errorItems.size} baseline errors + ${flipped.size} flipped by the ` +
      'planted regression)\n',
  );
}

await main();
