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
 *
 * ## A number belongs to a split
 *
 * A macro F1 is not a property of a model alone: it is a property of a model
 * MEASURED ON A PARTITION. When the gate is told which split is currently
 * tracked (`currentSplitPath`), it checks the partition before it compares
 * anything:
 *
 *  - a tracked split without a held-out partition (`val` / `test`) measures
 *    nothing, so the gate FAILS;
 *  - a RUN that was measured against ANOTHER split must not be compared: the
 *    run's own `splitFingerprint` (the manifest hash of the split it was
 *    scored against) must BE the tracked split, so the gate FAILS and names
 *    both fingerprints and both split ids;
 *  - a RUN that cannot be attributed to a split at all (no fingerprint) is
 *    not compared either: a number that cannot be attributed to the tracked
 *    split must not bless a run;
 *  - a tracked BASELINE that was measured against ANOTHER split (the split is
 *    found by the `splitFingerprint` of the entry, which is the manifest hash
 *    of the split the run was scored against) must not bless the current run,
 *    so the gate FAILS and names BOTH splits;
 *  - a tracked BASELINE that carries no `splitFingerprint` cannot be
 *    attributed to a split at all, so it is not compared either.
 *
 * The gate never weakens itself to make an old number pass: a number measured
 * on a partition the platform no longer tracks is retired with an explicit
 * reason, not compared.
 *
 * ## A scorecard is a regime, not just a split
 *
 * A run that carries a scorecard is a test-partition number; a baseline
 * recorded by the whole-set runner is a whole-set number, and the two SHARE a
 * split fingerprint, so the split-identity checks alone cannot tell them
 * apart. The gate therefore routes such a comparison through the scorecard's
 * own guard (`checkScorecardBaseline`, spec 022) before any macro F1 is
 * compared: a cross-regime, retired, other-split or partial baseline is
 * refused with the scorecard's typed error codes (FR-014, FR-020). A run
 * that carries no scorecard is compared exactly as before.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MetricsResult } from './metrics.js';
import { checkScorecardBaseline, type Scorecard } from './scorecard.js';

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
  /**
   * The code snapshot the baseline was recorded from.
   *
   * ADR-008: every metric artifact must resolve the snapshot, the split and
   * the config that produced it. The baseline is the TRACKED artifact — the
   * run report under `benchmarks/results/` is gitignored — so the baseline
   * itself has to carry the attribution, or the number in the repository
   * cannot be traced back to the experiment that produced it.
   */
  readonly snapshotId?: string;
  /**
   * The manifest hash of the split FILE the recorded run was measured against.
   *
   * It is the identity of the split file, so the gate can resolve it to the
   * split that is tracked now. A baseline that carries no fingerprint cannot
   * be attributed to a split and is therefore never compared.
   */
  readonly splitFingerprint?: string;
  /** The config fingerprint of the recorded run. */
  readonly configFingerprint?: string;
  /**
   * The metric regime of the recorded number (spec 022, FR-014): the
   * scorecard's own `regime` when the baseline is written from a scorecard
   * run. An entry that carries none is a whole-set runner number.
   */
  readonly regime?: string;
  /**
   * The state of the entry.
   *
   * `retired` marks a HISTORICAL artifact: the number was measured, it is
   * kept as evidence, and it is NOT compared against any more. A retired
   * entry is skipped by the gate exactly like a missing one, because a
   * number that was measured on a split the platform no longer tracks must
   * never bless a run (VLN-007: the first VisA measurement was taken on a
   * degenerate all-train split, which is not a performance figure).
   */
  readonly status?: 'active' | 'retired';
  /** Why the entry was retired (the reason travels with the artifact). */
  readonly retiredReason?: string;
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
  /**
   * The split identity of the comparison, when the gate could determine it.
   *
   * `recordedSplitId` is the split the number under evaluation was measured
   * against (the tracked baseline's split when the comparison happens, the
   * run's own split when the run is refused), `currentSplitId` the split that
   * is tracked now. They are equal when the number and the tracked split
   * describe the same partition.
   */
  readonly split?: GateSplitIdentity;
}

/**
 * Which split a benchmark number belongs to.
 *
 * The ids are the file names of the split manifests without their extension
 * (`visa-subset.v2.gold`), so a reader can find the file behind each id.
 */
export interface GateSplitIdentity {
  /** The split the number under evaluation was measured against. */
  readonly recordedSplitId: string;
  /** The split that is currently tracked for the suite. */
  readonly currentSplitId: string;
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
  /**
   * The scorecard of the run being gated, when the run produced one.
   *
   * A scorecard is a test-partition number (`regime: SCORECARD_REGIME`), while
   * a baseline recorded by the whole-set runner is a whole-set number; the two
   * share a split fingerprint, so the split-identity checks alone cannot tell
   * them apart. When the run carries its scorecard, the gate routes the
   * baseline comparison through the scorecard's own guard
   * (`checkScorecardBaseline`, spec 022) before any number is compared: a
   * cross-regime, retired, other-split or partial baseline is refused with the
   * scorecard's typed error codes (FR-014, FR-020). A run that carries no
   * scorecard is compared exactly as before.
   */
  readonly scorecard?: Scorecard;
  /**
   * The reproduction tuple of the run being gated.
   *
   * It is recorded in the baseline when the baseline is written, so the
   * tracked baseline names the snapshot, the split and the config the number
   * belongs to.
   *
   * `splitFingerprint` is the MANIFEST HASH of the split the run was scored
   * against, which is the identity of the split FILE. When the tracked split
   * is known, the gate refuses to compare a run whose fingerprint is not
   * that manifest hash.
   */
  readonly attribution?: {
    readonly snapshotId?: string;
    readonly splitFingerprint?: string;
    readonly configFingerprint?: string;
  };
  /** Whether the run is partial. A partial run is skipped. */
  readonly partial?: boolean;
  /** The regression tolerance. Defaults to −0.02. */
  readonly tolerance?: number;
  /** Where the baseline file lives. Defaults to `benchmarks/baselines/<suite>.json`. */
  readonly baselinePath?: string;
  /**
   * The split manifest that is CURRENTLY tracked for the suite.
   *
   * When it is given, the gate checks three things before it compares
   * anything:
   *
   *  1. the tracked split must have a HELD-OUT partition (`val` or `test`),
   *     because a split without one cannot measure anything;
   *  2. the RUN must have been measured against that very split: its
   *     `attribution.splitFingerprint` (the manifest hash of the split it was
   *     scored against) must be the tracked split's manifest hash. A run
   *     measured on another partition, or a run that cannot be attributed to
   *     a split at all, is not compared;
   *  3. the split the tracked baseline was measured against must BE the
   *     tracked split, because a number measured on a partition the platform
   *     no longer tracks must not bless a run. A baseline that carries no
   *     `splitFingerprint` cannot be attributed to a split and is not
   *     compared either.
   *
   * The third check compares against the baseline that is recorded NOW, so it
   * is skipped when the caller rewrites the baseline (`updateBaseline`): a new
   * baseline is how a run against a new split replaces the old one. The first
   * and the second check always apply, so a split without a held-out
   * partition can never be blessed into a baseline, and a run measured on
   * another split can never be recorded as one.
   */
  readonly currentSplitPath?: string;
  /**
   * The directory holding the tracked split manifests.
   *
   * The gate looks there for the split whose manifest hash is the
   * `splitFingerprint` of the baseline entry, which is the split the tracked
   * number was measured against. Defaults to the directory of
   * `currentSplitPath`.
   */
  readonly splitsDir?: string;
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
      entry.status !== 'retired' &&
      entry.suite === suite &&
      entry.model === model &&
      (entry.modelVersion ?? '') === modelVersion,
  );
}

/**
 * The RETIRED baseline entry of a (suite, model, model version) triple.
 *
 * A retired entry is kept as evidence but is never compared against: the
 * number it carries was measured on a split the platform no longer tracks,
 * so it can neither bless nor fail a run.
 */
export function findRetiredBaselineEntry(
  file: BaselineFile | undefined,
  suite: string,
  model: string,
  modelVersion = '',
): BaselineEntry | undefined {
  return file?.entries.find(
    (entry) =>
      entry.status === 'retired' &&
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

/* ------------------------------------------------------------------ *
 * The split identity
 * ------------------------------------------------------------------ */

/** The file suffix of a split manifest. */
const SPLIT_MANIFEST_SUFFIX = '.json';

/** The part of a split manifest the gate reads. */
interface SplitManifestSummary {
  /** The manifest hash, the identity of the split file. */
  readonly manifestHash: string;
  /** The assignments, reduced to the split each item sits in. */
  readonly assignments: ReadonlyArray<{ readonly split?: string }>;
}

/** The split id of a split manifest file: its name without the extension. */
export function splitIdFromPath(filePath: string): string {
  const base = path.basename(filePath);
  return base.endsWith(SPLIT_MANIFEST_SUFFIX)
    ? base.slice(0, -SPLIT_MANIFEST_SUFFIX.length)
    : base;
}

/** Reads a split manifest, reduced to what the gate needs. */
function readSplitManifestSummary(filePath: string): SplitManifestSummary | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<SplitManifestSummary>;
    if (typeof parsed.manifestHash !== 'string') return undefined;
    if (!Array.isArray(parsed.assignments)) return undefined;
    return { manifestHash: parsed.manifestHash, assignments: parsed.assignments };
  } catch {
    return undefined;
  }
}

/**
 * The split file in `splitsDir` whose manifest hash is `fingerprint`.
 *
 * The fingerprint of a recorded run IS the manifest hash of the split it was
 * measured against (the runner attributes a run to the manifest it scored),
 * so the file that carries that hash is the split the number belongs to.
 */
export function findSplitByFingerprint(
  splitsDir: string,
  fingerprint: string,
): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(splitsDir);
  } catch {
    return undefined;
  }
  for (const name of entries.filter((entry) => entry.endsWith(SPLIT_MANIFEST_SUFFIX)).sort()) {
    const manifest = readSplitManifestSummary(path.join(splitsDir, name));
    if (manifest !== undefined && manifest.manifestHash === fingerprint) {
      return path.join(splitsDir, name);
    }
  }
  return undefined;
}

/** The split currently tracked for the suite. */
interface CurrentSplit {
  /** The split id (the file name without its extension). */
  readonly id: string;
  /** The absolute path of the split manifest. */
  readonly path: string;
  /** The manifest, or `undefined` when it cannot be read. */
  readonly manifest: SplitManifestSummary | undefined;
}

/** Reads the split manifest that is currently tracked for the suite. */
function readCurrentSplit(currentSplitPath: string): CurrentSplit {
  const absolute = path.resolve(currentSplitPath);
  return {
    id: splitIdFromPath(absolute),
    path: absolute,
    manifest: readSplitManifestSummary(absolute),
  };
}

/** A gate verdict that is a failure and carries no comparison. */
function failedGate(reason: string, extra: Partial<GateResult> = {}): GateResult {
  return {
    passed: false,
    skipped: false,
    reason,
    macroF1Delta: 0,
    deltas: [],
    regressedClasses: [],
    ...extra,
  };
}

/**
 * Evaluate the gate.
 *
 * Never throws for a business outcome — a regression is a result, not an
 * exception. It throws only when the caller asks for a baseline rewrite that
 * needs `--force` and did not provide it: in that case nothing is written.
 *
 * ## The split comes first
 *
 * When `currentSplitPath` is given, the gate refuses to compare anything
 * before it has checked WHICH split the numbers belong to:
 *
 *  - a tracked split without a held-out partition measures nothing, so the
 *    gate fails;
 *  - a RUN measured against ANOTHER split must not be compared, so the gate
 *    fails and names both fingerprints and both split ids;
 *  - a RUN that cannot be attributed to a split at all must not be compared
 *    either, so the gate fails;
 *  - a tracked BASELINE that was measured against ANOTHER split must not
 *    bless the current run, so the gate fails and names both splits;
 *  - a tracked BASELINE that carries no split fingerprint cannot be
 *    attributed to a split, so it is not compared either.
 *
 * The checks are made before the macro F1 comparison, because a comparison
 * against a partition the platform no longer tracks is a number without a
 * meaning, not a regression.
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
        'gate=skipped: the run is partial, so it is not compared against the baseline ' +
        '(a partial run must never flap the gate).',
      macroF1Delta: 0,
      deltas: [],
      regressedClasses: [],
    };
  }

  // 1. The split that is currently tracked for the suite.
  const currentSplit =
    options.currentSplitPath === undefined ? undefined : readCurrentSplit(options.currentSplitPath);
  const currentManifest = currentSplit?.manifest;

  if (currentSplit !== undefined && currentManifest === undefined) {
    return failedGate(
      `the split currently tracked for '${options.suite}' cannot be read: '${currentSplit.path}' ` +
        'is missing or is not a split manifest. The gate refuses to compare a run against an ' +
        'unknown split.',
    );
  }

  // 2. The tracked split must have a held-out partition.
  if (currentSplit !== undefined && currentManifest !== undefined) {
    const heldOut = currentManifest.assignments.filter(
      (assignment) => assignment.split === 'val' || assignment.split === 'test',
    ).length;
    if (heldOut === 0) {
      return failedGate(
        `the split currently tracked for '${options.suite}' ('${currentSplit.id}') has no held-out ` +
          `partition: all ${currentManifest.assignments.length} assignments are in 'train'. A ` +
          'number measured on a split without held-out data measures nothing and must not be ' +
          'published.',
      );
    }
  }

  const file = readBaselineFile(baselinePath);
  const modelVersion = options.modelVersion ?? '';
  const baseline = findBaselineEntry(file, options.suite, options.model, modelVersion);

  // 3. The RUN under evaluation must have been measured against the split
  //    that is tracked now. The run's own fingerprint (the manifest hash of
  //    the split it was scored against) is the identity of that split file,
  //    so a run measured on the OLD split is refused here, before any
  //    comparison happens.
  if (currentSplit !== undefined && currentManifest !== undefined) {
    const runFingerprint = options.attribution?.splitFingerprint;
    if (runFingerprint === undefined) {
      return failedGate(
        `the run under evaluation cannot be attributed to a split: it carries no split ` +
          `fingerprint, so it cannot be shown to have been measured against the split ` +
          `currently tracked for '${options.suite}' ('${currentSplit.id}'). A number that ` +
          'cannot be attributed to the tracked split must not bless a run.',
      );
    }
    if (runFingerprint !== currentManifest.manifestHash) {
      const splitsDir = options.splitsDir ?? path.dirname(currentSplit.path);
      const recordedPath = findSplitByFingerprint(splitsDir, runFingerprint);
      const recordedSplitId =
        recordedPath === undefined ? undefined : splitIdFromPath(recordedPath);
      const measuredAgainst =
        recordedSplitId === undefined
          ? `a split with the manifest hash '${runFingerprint}'`
          : `the split '${recordedSplitId}' (manifest hash '${runFingerprint}')`;
      return failedGate(
        `the run under evaluation was measured against ${measuredAgainst}, but the split ` +
          `currently tracked for '${options.suite}' is '${currentSplit.id}' (manifest hash ` +
          `'${currentManifest.manifestHash}'). The macro F1 was measured on a different ` +
          'partition, so it is not compared: re-run the predictions against the tracked split.',
        recordedSplitId === undefined
          ? {}
          : { split: { recordedSplitId, currentSplitId: currentSplit.id } },
      );
    }
  }

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
      ...(options.attribution?.snapshotId === undefined
        ? {}
        : { snapshotId: options.attribution.snapshotId }),
      ...(options.attribution?.splitFingerprint === undefined
        ? {}
        : { splitFingerprint: options.attribution.splitFingerprint }),
      ...(options.attribution?.configFingerprint === undefined
        ? {}
        : { configFingerprint: options.attribution.configFingerprint }),
      // A baseline recorded from a scorecard run carries the scorecard's own
      // regime (spec 022, FR-014), so the next scorecard run reads it back as
      // the same regime instead of a whole-set number. A whole-set rewrite
      // adds no key and stays byte-identical to what it wrote before.
      ...(options.scorecard === undefined ? {} : { regime: options.scorecard.regime }),
      generatedAt: now.toISOString(),
    };

    // A RETIRED entry is never removed and never overwritten: it is the
    // evidence of the measurement that was taken on a split the platform no
    // longer tracks. Writing a new baseline for the same (suite, model,
    // model version) SUPERSEDES the retired one: the retired entry stays in
    // the file and the new ACTIVE entry is added alongside it.
    const entries = [
      ...(file?.entries ?? []).filter(
        (existing) =>
          existing.status === 'retired' ||
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

  // 4. The regime check of the scorecard (spec 022, FR-014, FR-020): a run
  //    that carries a scorecard is compared against the baseline only through
  //    the scorecard's own guard, BEFORE any number is compared. The guard
  //    refuses a partial scorecard, a retired baseline (evidence, never a
  //    comparison), a baseline of another split (both digests named) and a
  //    cross-regime baseline (a test-partition scorecard against a whole-set
  //    number), each with its typed code. A RETIRED entry reaches the guard
  //    here: against a scorecard it is REFUSED with its recorded reason, not
  //    skipped, so a historical number can never silently bless a
  //    test-partition run. Like the split-identity check below, this compares
  //    against the baseline recorded NOW, so it is skipped when the caller
  //    rewrites the baseline: recording a new baseline is how a suite migrates
  //    from the whole-set regime to the scorecard regime.
  if (options.scorecard !== undefined) {
    const scorecardBaseline =
      baseline ?? findRetiredBaselineEntry(file, options.suite, options.model, modelVersion);
    if (scorecardBaseline !== undefined) {
      const check = checkScorecardBaseline(options.scorecard, scorecardBaseline);
      if (!check.ok) {
        return failedGate(
          `${check.error.message} (scorecard error code '${check.error.code}')`,
        );
      }
    }
  }

  if (baseline === undefined) {
    const retired = findRetiredBaselineEntry(file, options.suite, options.model, modelVersion);
    return {
      passed: true,
      skipped: true,
      reason:
        `gate=skipped: no baseline is recorded for '${options.suite}/${options.model}' in ` +
        `${baselinePath}.` +
        (retired === undefined
          ? ' Record one with --update-baseline.'
          : ` The previous baseline was RETIRED and is not compared against: ` +
            `${retired.retiredReason ?? 'no reason recorded'}`),
      macroF1Delta: 0,
      deltas: [],
      regressedClasses: [],
    };
  }

  // 5. The split the tracked baseline was measured against must BE the split
  //    that is tracked now. A number measured on a partition the platform no
  //    longer tracks must not bless a run.
  let splitIdentity: GateSplitIdentity | undefined;
  if (currentSplit !== undefined && currentManifest !== undefined) {
    if (baseline.splitFingerprint === undefined) {
      return failedGate(
        `the tracked baseline of '${options.suite}/${options.model}' carries no split ` +
          `fingerprint, so it cannot be attributed to the split currently tracked for this ` +
          `suite ('${currentSplit.id}'). A baseline that cannot be attributed to the tracked ` +
          'split must not bless a run: record a baseline from a run that was measured against ' +
          'the tracked split.',
      );
    }
    const splitsDir = options.splitsDir ?? path.dirname(currentSplit.path);
    const recordedPath = findSplitByFingerprint(splitsDir, baseline.splitFingerprint);
    if (recordedPath === undefined) {
      return failedGate(
        `the split the tracked baseline of '${options.suite}/${options.model}' was measured against ` +
          `(fingerprint '${baseline.splitFingerprint}') is not among the tracked splits in ` +
          `'${splitsDir}'. The number cannot be attributed to a split, so it is not compared.`,
      );
    }
    const recordedSplitId = splitIdFromPath(recordedPath);
    splitIdentity = { recordedSplitId, currentSplitId: currentSplit.id };
    if (recordedSplitId !== currentSplit.id) {
      return failedGate(
        `the tracked baseline of '${options.suite}/${options.model}' was recorded against the split ` +
          `'${recordedSplitId}', but the split currently tracked for this suite is ` +
          `'${currentSplit.id}'. The macro F1 was measured on a different partition, so it must ` +
          'not bless this run: re-run the predictions against the tracked split and record a new ' +
          'baseline.',
        { split: splitIdentity },
      );
    }
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
    ...(splitIdentity === undefined ? {} : { split: splitIdentity }),
  };
}
