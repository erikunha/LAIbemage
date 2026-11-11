/**
 * Benchmark regression gate — spec 003, US4 (FR-006, SC-003).
 *
 * ## What the gate does
 *
 * It compares a benchmark run against the stored baseline for the same
 * (suite, model) pair and fails when the macro F1 regressed by more than the
 * tolerance. The default tolerance is **−0.02**: a drop of exactly 0.02 still
 * passes, a drop of 0.0201 fails.
 *
 * ## Why the per-class deltas matter
 *
 * A macro F1 drop is a symptom, not a diagnosis. When the gate fails it must
 * say WHICH classes regressed — otherwise the reader has to diff two reports
 * by hand to find out what broke. `deltas` and `regressedClasses` carry that.
 *
 * ## Partial runs never flap
 *
 * A run marked partial (a provider outage, an interrupted evaluation) is
 * **skipped**, never compared and never failed. A gate that fails on an
 * outage trains its readers to ignore it.
 *
 * ## Baselines are reviewed artifacts
 *
 * `--update-baseline` rewrites the baseline file with a dated header. A change
 * larger than 0.05 in macro F1 additionally requires an explicit `force`:
 * moving a baseline is a decision, not a side effect of a run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MetricsResult } from './metrics.js';

/** Schema version of the baseline file. Bump on a breaking change. */
export const BASELINE_SCHEMA_VERSION = 1;

/** Default regression tolerance on the macro F1. */
export const DEFAULT_GATE_TOLERANCE = -0.02;

/**
 * The change that requires an explicit `force` when a baseline is rewritten.
 *
 * A baseline that moves by more than this is a different benchmark, not an
 * update, and it must be reviewed by a human before it is written.
 */
export const BASELINE_REVIEW_THRESHOLD = 0.05;

/**
 * The slack the tolerance comparison gets.
 *
 * A macro F1 is a quotient of two integers, so a delta that is *mathematically*
 * exactly −0.02 is usually not exactly −0.02 in binary floating point (it is
 * typically −0.020000000000000018). Comparing the raw values would fail a run
 * that regressed by exactly the tolerated amount. The comparison therefore
 * treats deltas within this slack of the tolerance as "at the tolerance".
 */
export const GATE_TOLERANCE_EPSILON = 1e-9;

/** One (suite, model, model version) entry of a baseline file. */
export interface BaselineEntry {
  readonly suite: string;
  readonly model: string;
  /**
   * The model VERSION the baseline was recorded from.
   *
   * A baseline is only comparable with a run of the same model AND the same
   * model version: `gpt-4o` and `gpt-4o-2025-11` are different models, and
   * comparing their macro F1 would be a comparison of two different things.
   * The baseline is therefore keyed by the triple.
   */
  readonly modelVersion?: string;
  /** The macro F1 of the run the baseline was recorded from. */
  readonly macroF1: number;
  /** Per-class F1, keyed by label. */
  readonly perClass: Readonly<Record<string, number>>;
  readonly balancedAccuracy?: number;
  readonly ece?: number;
  /** The date the entry was recorded (ISO 8601). */
  readonly generatedAt: string;
}

/** The baseline file: a dated header plus one entry per (suite, model). */
export interface BaselineFile {
  readonly schemaVersion: number;
  /** The date the file was written (ISO 8601) — the dated header. */
  readonly generatedAt: string;
  readonly entries: readonly BaselineEntry[];
}

/** The per-class difference between the baseline and the current run. */
export interface ClassDelta {
  readonly labelKey: string;
  readonly baseline: number;
  readonly current: number;
  /** `current - baseline` — negative means a regression. */
  readonly delta: number;
}

/** The verdict of one gate evaluation. */
export interface GateResult {
  /** Whether the run passed the gate. A skipped gate passes. */
  readonly passed: boolean;
  /** Whether the comparison was skipped (partial run, missing baseline). */
  readonly skipped: boolean;
  /** Human-readable explanation, always populated. */
  readonly reason: string;
  /** `current - baseline` on the macro F1. `0` when skipped. */
  readonly macroF1Delta: number;
  /** Per-class deltas, sorted by label. */
  readonly deltas: readonly ClassDelta[];
  /** The labels whose F1 regressed, sorted. */
  readonly regressedClasses: readonly string[];
  /** The baseline entry the run was compared against. */
  readonly baseline?: BaselineEntry;
  /** Whether the baseline file was rewritten. */
  readonly updated?: boolean;
}

/** Options of {@link evaluateGate}. */
export interface GateOptions {
  readonly suite: string;
  readonly model: string;
  /**
   * The model VERSION of the run being gated. A baseline recorded for a
   * different version is a different model, and comparing them would be a
   * comparison of two different things — so the baseline is looked up by the
   * (suite, model, version) triple.
   */
  readonly modelVersion?: string;
  /** The metrics of the run being gated. */
  readonly metrics: MetricsResult;
  /** Whether the run is partial. A partial run is skipped. */
  readonly partial?: boolean;
  /** The regression tolerance. Defaults to −0.02. */
  readonly tolerance?: number;
  /** Where the baseline file lives. Defaults to `benchmarks/baselines/<suite>.json`. */
  readonly baselinePath?: string;
  /** Rewrite the baseline file with this run's metrics. */
  readonly updateBaseline?: boolean;
  /** Required when the macro F1 changes by more than 0.05. */
  readonly force?: boolean;
  /** Injectable clock, so the dated header is stable in tests. */
  readonly now?: Date;
}

/** Default baseline path for a suite. */
export function defaultBaselinePath(suite: string): string {
  return path.join('benchmarks', 'baselines', `${suite}.json`);
}

/**
 * Read a baseline file.
 *
 * A missing file is NOT an error: it returns `undefined` so the caller can
 * report "no baseline recorded yet" instead of crashing.
 */
export function readBaselineFile(baselinePath: string): BaselineFile | undefined {
  if (!existsSync(baselinePath)) return undefined;
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile;
  return {
    schemaVersion: parsed.schemaVersion ?? BASELINE_SCHEMA_VERSION,
    generatedAt: parsed.generatedAt,
    entries: parsed.entries ?? [],
  };
}

/** Write a baseline file, creating its directory when needed. */
export function writeBaselineFile(baselinePath: string, file: BaselineFile): void {
  mkdirSync(path.dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** The baseline entry of a (suite, model, model version) triple, when there is one. */
export function findBaselineEntry(
  file: BaselineFile | undefined,
  suite: string,
  model: string,
  modelVersion = '',
): BaselineEntry | undefined {
  return file?.entries.find(
    (entry) =>
      entry.suite === suite &&
      entry.model === model &&
      (entry.modelVersion ?? '') === modelVersion,
  );
}

/**
 * The per-class deltas between the baseline and the current run.
 *
 * A class that exists in only one of the two sides is reported with the
 * missing side treated as `0` — a class that vanished from the metrics is a
 * regression, and hiding it would make the gate blind to it.
 */
export function computeClassDeltas(
  baseline: BaselineEntry | undefined,
  metrics: MetricsResult,
): ClassDelta[] {
  const current = new Map<string, number>(
    metrics.perClass.map((entry) => [entry.labelKey, entry.f1]),
  );
  const baselineClasses = new Map<string, number>(
    Object.entries(baseline?.perClass ?? {}),
  );
  const labels = [...new Set([...current.keys(), ...baselineClasses.keys()])].sort();

  return labels.map((labelKey) => {
    const base = baselineClasses.get(labelKey) ?? 0;
    const now = current.get(labelKey) ?? 0;
    return { labelKey, baseline: base, current: now, delta: now - base };
  });
}

/**
 * The macro F1 of both runs over the SAME set of classes.
 *
 * The verdict must compare like with like. Two runs rarely score exactly the
 * same classes — a class can fall below `minSamples` and drop out — and the
 * plain macro F1 of each run is then not comparable: dropping a badly-scored
 * class RAISES the mean, so a collapsed class could make the gate PASS.
 *
 * The comparison therefore uses the UNION of both class sets, with a class
 * missing from one side counted as `0`. A vanished class can no longer raise
 * the score; it drags it down, exactly as it should.
 */
export function compareMacroF1(
  baseline: BaselineEntry | undefined,
  metrics: MetricsResult,
): {
  readonly baselineMacroF1: number;
  readonly currentMacroF1: number;
  readonly delta: number;
  readonly comparedClasses: readonly string[];
  readonly changedClasses: readonly string[];
} {
  const current = new Map<string, number>(
    metrics.perClass.map((entry) => [entry.labelKey, entry.f1]),
  );
  const baselineClasses = new Map<string, number>(
    Object.entries(baseline?.perClass ?? {}),
  );
  const comparedClasses = [...new Set([...current.keys(), ...baselineClasses.keys()])].sort();

  if (comparedClasses.length === 0) {
    return {
      baselineMacroF1: 0,
      currentMacroF1: 0,
      delta: 0,
      comparedClasses: [],
      changedClasses: [],
    };
  }

  let baselineTotal = 0;
  let currentTotal = 0;
  for (const labelKey of comparedClasses) {
    baselineTotal += baselineClasses.get(labelKey) ?? 0;
    currentTotal += current.get(labelKey) ?? 0;
  }

  const baselineMacroF1 = baselineTotal / comparedClasses.length;
  const currentMacroF1 = currentTotal / comparedClasses.length;

  const changedClasses = comparedClasses.filter(
    (labelKey) =>
      !baselineClasses.has(labelKey) || !current.has(labelKey),
  );

  return {
    baselineMacroF1,
    currentMacroF1,
    delta: currentMacroF1 - baselineMacroF1,
    comparedClasses,
    changedClasses,
  };
}

/**
 * Evaluate the gate.
 *
 * Never throws for a business outcome — a regression is a result, not an
 * exception. It throws only when the caller asks for a baseline rewrite that
 * needs `--force` and did not provide it: in that case nothing is written.
 */
export function evaluateGate(options: GateOptions): GateResult {
  const tolerance = options.tolerance ?? DEFAULT_GATE_TOLERANCE;
  const baselinePath = options.baselinePath ?? defaultBaselinePath(options.suite);
  const now = options.now ?? new Date();

  if (options.partial === true) {
    return {
      passed: true,
      skipped: true,
      reason:
        'gate=skipped — the run is partial, so it is not compared against the baseline ' +
        '(a partial run must never flap the gate).',
      macroF1Delta: 0,
      deltas: [],
      regressedClasses: [],
    };
  }

  const file = readBaselineFile(baselinePath);
  const modelVersion = options.modelVersion ?? '';
  const baseline = findBaselineEntry(file, options.suite, options.model, modelVersion);

  if (options.updateBaseline === true) {
    const delta = baseline === undefined ? 0 : options.metrics.macroF1 - baseline.macroF1;
    if (baseline !== undefined && Math.abs(delta) > BASELINE_REVIEW_THRESHOLD) {
      if (options.force !== true) {
        throw new Error(
          `refusing to update the baseline of '${options.suite}/${options.model}': the macro F1 ` +
            `changes by ${delta.toFixed(4)}, which is more than the review threshold of ` +
            `${BASELINE_REVIEW_THRESHOLD}. Re-run with --force once the change is reviewed.`,
        );
      }
    }

    const entry: BaselineEntry = {
      suite: options.suite,
      model: options.model,
      ...(modelVersion === '' ? {} : { modelVersion }),
      macroF1: options.metrics.macroF1,
      perClass: Object.fromEntries(
        options.metrics.perClass.map((metrics) => [metrics.labelKey, metrics.f1]),
      ),
      balancedAccuracy: options.metrics.balancedAccuracy,
      ece: undefined,
      generatedAt: now.toISOString(),
    };

    const entries = [
      ...(file?.entries ?? []).filter(
        (existing) =>
          !(
            existing.suite === options.suite &&
            existing.model === options.model &&
            (existing.modelVersion ?? '') === modelVersion
          ),
      ),
      entry,
    ];
    writeBaselineFile(baselinePath, {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      entries,
    });

    return {
      passed: true,
      skipped: false,
      reason: `baseline updated — ${options.suite}/${options.model} now records macro F1 ${options.metrics.macroF1.toFixed(4)}.`,
      macroF1Delta: delta,
      deltas: computeClassDeltas(baseline, options.metrics),
      regressedClasses: [],
      baseline: entry,
      updated: true,
    };
  }

  if (baseline === undefined) {
    return {
      passed: true,
      skipped: true,
      reason:
        `gate=skipped — no baseline is recorded for '${options.suite}/${options.model}' in ` +
        `${baselinePath}. Record one with --update-baseline.`,
      macroF1Delta: 0,
      deltas: [],
      regressedClasses: [],
    };
  }

  const comparison = compareMacroF1(baseline, options.metrics);
  const macroF1Delta = comparison.delta;
  const deltas = computeClassDeltas(baseline, options.metrics);
  const regressedClasses = deltas
    .filter((delta) => delta.delta < 0)
    .map((delta) => delta.labelKey)
    .sort();

  const failed = macroF1Delta < tolerance - GATE_TOLERANCE_EPSILON;
  const classSetNote =
    comparison.changedClasses.length > 0
      ? ` The scored class set changed (${comparison.changedClasses.join(', ')}); the comparison ` +
        'is made over the union of both class sets, with a class missing from one side counted as 0.'
      : '';
  const reason = failed
    ? `macro F1 regressed by ${Math.abs(macroF1Delta).toFixed(4)}, which is more than the ` +
      `tolerance of ${Math.abs(tolerance).toFixed(4)}. Regressed classes: ` +
      `${regressedClasses.length > 0 ? regressedClasses.join(', ') : 'none'}.${classSetNote}`
    : `macro F1 moved by ${macroF1Delta.toFixed(4)}, within the tolerance of ${tolerance.toFixed(4)}.${classSetNote}`;

  return {
    passed: !failed,
    skipped: false,
    reason,
    macroF1Delta,
    deltas,
    regressedClasses,
    baseline,
  };
}
