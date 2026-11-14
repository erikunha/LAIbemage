/**
 * `vision-lens benchmark run|gate|report|scorecard`: the spec-003 benchmark
 * surface (US3, US4) and the spec-022 scorecard surface.
 *
 * ## The four commands
 *
 *  - `run`      : score a prediction set against a gold split and emit the
 *                 attributed artifacts under `benchmarks/results/<runId>/`.
 *  - `gate`     : compare a run against the stored baseline and fail the build
 *                 when the macro F1 regressed beyond the tolerance.
 *  - `report`   : print a stored artifact as a compact summary.
 *  - `scorecard`: measure the held-out `test` partition and publish the
 *                 per-sample artifact, the scorecard and the committed pointer.
 *
 * ## What this command refuses to do
 *
 * It never downloads a dataset, never invents a number and never emits a
 * report without a reproduction tuple. When the dataset (or the split) is
 * absent it prints an explicit `dataset=absent` marker and exits cleanly —
 * a missing dataset is a skip, not a failure, and it is certainly not a
 * reason to fabricate a score.
 *
 * The scorecard command adds one more refusal: a typed failure never writes
 * a scorecard. A refused scorecard is a refusal, not a zero.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  BenchmarkReport,
  DatasetRegistry,
  GateResult,
  GoldItem,
  MetricsResult,
  PredictionItem,
  ScorecardDeviceInput,
  SplitAssignment,
  SplitManifest,
} from '@vision-lens/core/benchmark';
import {
  buildScorecard,
  captureEnv,
  defaultScorecardPointerPath,
  evaluateGate,
  findDataset,
  loadDatasetRegistry,
  runBenchmark,
  writeScorecardArtifacts,
  assertDatasetUsable,
  DEFAULT_GATE_TOLERANCE,
} from '@vision-lens/core/benchmark';
import { logger } from '@vision-lens/core/utils/logger';

/** Options of the `vision-lens benchmark run` command. */
export interface BenchmarkRunOptions {
  readonly suite: string;
  readonly model: string;
  /** Path of the split manifest (gold split). */
  readonly splitPath?: string;
  /** Path of an explicit gold-label file (JSON array of `{id, labelKey}`). */
  readonly goldPath?: string;
  /** Path of the predictions file (JSON array of `PredictionItem`). */
  readonly predictionsPath?: string;
  /** Where the artifacts are written. Defaults to `benchmarks/results`. */
  readonly outputDir?: string;
  /** Minimum gold samples per class. */
  readonly minSamples?: number;
  /** The code snapshot the run belongs to. Defaults to the current git HEAD. */
  readonly snapshotId?: string;
  /**
   * The split fingerprint of the run: the MANIFEST HASH of the split file the
   * run is scored against. Defaults to the manifest hash of `--split`.
   */
  readonly splitFingerprint?: string;
  /** The model identity AND version. */
  readonly modelVersion?: string;
  /** The config fingerprint the run used. */
  readonly configFingerprint?: string;
  /** Mark the run as partial (e.g. a provider outage). */
  readonly partial?: boolean;
  /** Extra non-secret environment facts to record in the artifact. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Options of the `vision-lens benchmark scorecard` command.
 *
 * The scorecard measures ONE partition: the held-out `test` partition of the
 * split it is given. The partition under evaluation is not a choice (FR-002),
 * so what the caller selects here is the SPLIT (the partition set), the
 * partition the ECE is computed on, the device, the support rule and where
 * the committed pointer lands.
 */
export interface BenchmarkScorecardOptions {
  readonly suite: string;
  readonly model: string;
  /** Path of the split manifest (gold split). */
  readonly splitPath?: string;
  /**
   * The partition the ECE is computed on. Defaults to `val`.
   *
   * The `test` partition is refused by the scorecard itself: an ECE computed
   * on the partition the score is measured on is not a calibration number.
   */
  readonly calibrationPartition?: string;
  /** Path of the predictions file (JSON array of `PredictionItem`). */
  readonly predictionsPath?: string;
  /** The device the predictions were produced on (e.g. `cpu`, `mps`). */
  readonly device?: string;
  /** The explicit support rule: a class below it is excluded from the rows. */
  readonly minSupport?: number;
  /** Where the artifacts are written. Defaults to the gitignored results dir. */
  readonly outputDir?: string;
  /** Where the committed pointer lands. Defaults to `benchmarks/scorecards/`. */
  readonly pointerDir?: string;
  /** The code snapshot the scorecard belongs to. Defaults to the git HEAD. */
  readonly snapshotId?: string;
  /** The manifest hash of the split the scorecard is measured against. */
  readonly splitFingerprint?: string;
  /** The model identity AND version. */
  readonly modelVersion?: string;
  /** The config fingerprint the scorecard used. */
  readonly configFingerprint?: string;
  /** Mark the scorecard as partial (e.g. a provider outage). */
  readonly partial?: boolean;
  /** Extra non-secret environment facts to record in the artifact. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Options of the `vision-lens benchmark gate` command. */
export interface BenchmarkGateOptions {
  readonly suite: string;
  readonly model: string;
  /** Path of a run artifact (`report.json`) to gate. */
  readonly metricsPath?: string;
  /** Path of the baseline file. */
  readonly baselinePath?: string;
  /**
   * Path of the split manifest that is currently tracked for the suite.
   *
   * Defaults to `benchmarks/splits/<suite>.gold.json`: the suite id names
   * the split the suite is tracked against.
   */
  readonly splitPath?: string;
  /** The regression tolerance. Defaults to −0.02. */
  readonly tolerance?: number;
  /** Rewrite the baseline file with the run's metrics. */
  readonly updateBaseline?: boolean;
  /** Required when the baseline moves by more than 0.05. */
  readonly force?: boolean;
  /** Treat the run as partial (it is then skipped, never failed). */
  readonly partial?: boolean;
}

/** Options of the `vision-lens benchmark report` command. */
export interface BenchmarkReportOptions {
  readonly runId: string;
  /** Directory holding the run artifacts. Defaults to `benchmarks/results`. */
  readonly dir?: string;
}

/** The marker printed whenever the dataset (or split) is not available. */
export const DATASET_ABSENT_MARKER = 'dataset=absent';

/**
 * The split manifest that is currently tracked for a suite.
 *
 * The suite id names the split it is tracked against, so the default is
 * `benchmarks/splits/<suite>.gold.json`. The `run` command scores against
 * that manifest and the `gate` command must be told the SAME one: a number is
 * only comparable with a baseline when both were measured on the same
 * partition.
 */
export function trackedSplitPath(suite: string, splitPath?: string): string {
  return splitPath ?? path.join('benchmarks', 'splits', `${suite}.gold.json`);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

/**
 * The current git HEAD, used as the default snapshot id.
 *
 * A report without a snapshot id is not attributable, so when git cannot
 * answer the command refuses instead of writing "unknown".
 */
function currentSnapshotId(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(
      'cannot determine the code snapshot id: git is unavailable or this is not a git ' +
        'repository. Pass --snapshot-id explicitly.',
    );
  }
}

/**
 * The gold items of a run.
 *
 * Two sources, in this order:
 *
 *  1. an explicit gold-label file (`--gold`), which is what the dataset
 *     normalizer produces: one `{id, labelKey}` per image;
 *  2. the split manifest itself, in which case the label key is derived from
 *     the assignment: `normal` for a normal image, `defect:<class>` for an
 *     anomalous one.
 */
function loadGoldItems(
  goldPath: string | undefined,
  manifest: SplitManifest | undefined,
): GoldItem[] {
  if (goldPath !== undefined) {
    if (!existsSync(goldPath)) {
      throw new Error(`gold label file not found: ${goldPath}`);
    }
    return readJsonFile<GoldItem[]>(goldPath);
  }
  if (manifest === undefined) {
    throw new Error(
      'no gold set: pass --gold <file> or --split <manifest>. The benchmark never ' +
        'derives ground truth on its own.',
    );
  }
  return manifest.assignments.map((assignment: SplitAssignment) => ({
    id: assignment.id,
    labelKey: labelKeyOf(assignment),
  }));
}

/** The label key an assignment is scored under. */
function labelKeyOf(assignment: SplitAssignment): string {
  return assignment.anomaly === 'normal' ? 'normal' : `defect:${assignment.class}`;
}

function formatNumber(value: number): string {
  return value.toFixed(4);
}

/**
 * The sha256 of every scored image, read from the dataset.
 *
 * The split manifest records the sha256 of every image; the runner refuses to
 * score an image set whose bytes diverge from it. That check only means
 * something if the ACTUAL bytes are hashed, so the CLI computes them from the
 * dataset root.
 *
 * The root is `datasets/<datasetId>` — the layout the fetch script produces.
 * When the dataset is not on disk (the synthetic fixture is generated, not
 * fetched), no hashes are returned and the runner records the fact as a
 * caveat instead of pretending the bytes were verified.
 */
function computeAssetHashes(
  manifest: SplitManifest,
  datasetId: string,
): Map<string, string> {
  const hashes = new Map<string, string>();
  const root = path.join('datasets', datasetId);
  if (!existsSync(root)) return hashes;

  for (const assignment of manifest.assignments) {
    const filePath = path.join(root, assignment.path);
    if (!existsSync(filePath)) continue;
    try {
      hashes.set(assignment.id, createHash('sha256').update(readFileSync(filePath)).digest('hex'));
    } catch {
      // A file that cannot be read is simply not verified; the runner
      // reports the count of unverified items as a caveat.
    }
  }
  return hashes;
}

/**
 * `vision-lens benchmark run` — score a prediction set and emit the artifacts.
 *
 * @returns `true` when the run produced artifacts, `false` when it was
 *   skipped because the dataset is absent.
 */
export async function runBenchmarkCommand(options: BenchmarkRunOptions): Promise<boolean> {
  const splitPath = trackedSplitPath(options.suite, options.splitPath);

  if (!existsSync(splitPath)) {
    logger.warn(`${DATASET_ABSENT_MARKER} — no split manifest at ${splitPath}.`);
    logger.warn('benchmark run skipped: fetch the dataset and generate the gold split first.');
    return false;
  }

  const manifest = readJsonFile<SplitManifest>(splitPath);

  // The split fingerprint IS the manifest hash: it names the split FILE the
  // run is scored against. A caller may restate it, but it may not contradict
  // it: an artifact fingerprinted with an unrelated value would be attributed
  // to a split it was not scored against.
  if (
    options.splitFingerprint !== undefined &&
    options.splitFingerprint !== manifest.manifestHash
  ) {
    throw new Error(
      `the split fingerprint '${options.splitFingerprint}' does not match the manifest ` +
        `'${manifest.id}', whose hash is '${manifest.manifestHash}'. Refusing to attribute a run ` +
        'to a split it was not scored against.',
    );
  }

  const gold = loadGoldItems(options.goldPath, manifest);

  if (options.predictionsPath === undefined) {
    throw new Error(
      'no predictions: pass --predictions <file> (a JSON array of predictions). ' +
        'The benchmark never invents predictions.',
    );
  }
  if (!existsSync(options.predictionsPath)) {
    throw new Error(`predictions file not found: ${options.predictionsPath}`);
  }
  const predictions = readJsonFile<PredictionItem[]>(options.predictionsPath);

  const result = await runBenchmark({
    suite: options.suite,
    model: options.model,
    gold,
    predictions,
    tuple: {
      snapshotId: options.snapshotId ?? currentSnapshotId(),
      splitFingerprint: options.splitFingerprint ?? manifest.manifestHash,
      modelVersion: options.modelVersion ?? '',
      configFingerprint: options.configFingerprint ?? '',
      // The environment capture is part of the attribution (ADR-008): an
      // artifact with an EMPTY environment field is not attributed. Only
      // non-secret facts are recorded — the runtime, the platform and the arch.
      env: captureEnv(options.env),
    },
    splitManifest: manifest,
    assetHashes: computeAssetHashes(manifest, manifest.datasetId),
    ...(options.minSamples === undefined ? {} : { minSamples: options.minSamples }),
    ...(options.partial === undefined ? {} : { partial: options.partial }),
    ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }),
  });

  logger.success(`benchmark run ${result.runId}`);
  logger.info(`items scored: ${result.metrics.itemsScored}`);
  logger.info(`macro F1: ${formatNumber(result.metrics.macroF1)}`);
  logger.info(`balanced accuracy: ${formatNumber(result.metrics.balancedAccuracy)}`);
  logger.info(`ECE: ${formatNumber(result.calibration.ece)}`);
  logger.info(`report: ${result.reportJsonPath}`);
  logger.info(`report: ${result.reportMarkdownPath}`);
  for (const caveat of result.caveats) {
    logger.warn(caveat);
  }
  return true;
}

/**
 * The outcome of the `vision-lens benchmark scorecard` command.
 *
 * The three outcomes are three different things, and the caller must not
 * confuse them: a written scorecard, a clean skip (the dataset is absent) and
 * a refusal (the scorecard was asked for and could not be produced).
 *
 * The refusal code is the scorecard's own code (`ScorecardErrorCode`), except
 * for `dataset-not-usable`: the constitutional dataset gate raises that one
 * before the scorecard is even built, and its message carries the gate's own
 * wording.
 */
export type ScorecardCommandOutcome =
  | {
      readonly status: 'written';
      readonly scorecardId: string;
      readonly pointerPath: string;
    }
  | { readonly status: 'skipped' }
  | { readonly status: 'refused'; readonly code: string; readonly message: string };

/**
 * The device facts of the scorecard.
 *
 * The caller has a string (a backend name, a machine name), so the kind is
 * recognised when it is one of the three backends the scorecard knows and
 * the string itself is recorded as the name. Anything else is recorded as
 * `unknown` with a limitation: the scorecard never guesses a device.
 */
function scorecardDeviceInput(device: string | undefined): ScorecardDeviceInput | undefined {
  if (device === undefined) return undefined;
  const trimmed = device.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'cpu' || trimmed === 'mps' || trimmed === 'cuda') {
    return { kind: trimmed };
  }
  return { kind: 'unknown', name: trimmed };
}

/**
 * The command that reproduces the artifacts of a scorecard.
 *
 * It carries every option the scorecard depends on, so running it as it
 * stands rebuilds the same measurement: the required attribution options
 * (`--model-version`, `--config-fingerprint`) and the inputs (the split, the
 * predictions) are part of it, and the optional ones are recorded only when
 * they were used.
 *
 * The snapshot is ALWAYS recorded, even when the caller defaulted it: the
 * default is the current HEAD, which moves, so a command that left it out
 * would reproduce the measurement against another code state and name
 * another snapshot than the pointer it ships with.
 */
function scorecardReproduceCommand(
  options: BenchmarkScorecardOptions,
  splitPath: string,
  snapshotId: string,
): string {
  const parts = [
    'vision-lens benchmark scorecard',
    `--suite ${options.suite}`,
    `--model-id ${options.model}`,
    `--split ${splitPath}`,
    `--snapshot-id ${snapshotId}`,
  ];
  if (options.predictionsPath !== undefined) {
    parts.push(`--predictions ${options.predictionsPath}`);
  }
  if (options.modelVersion !== undefined) {
    parts.push(`--model-version ${options.modelVersion}`);
  }
  if (options.configFingerprint !== undefined) {
    parts.push(`--config-fingerprint ${options.configFingerprint}`);
  }
  if (options.calibrationPartition !== undefined) {
    parts.push(`--calibration-partition ${options.calibrationPartition}`);
  }
  if (options.device !== undefined) {
    parts.push(`--device ${options.device}`);
  }
  if (options.minSupport !== undefined) {
    parts.push(`--min-support ${options.minSupport}`);
  }
  if (options.splitFingerprint !== undefined) {
    parts.push(`--split-fingerprint ${options.splitFingerprint}`);
  }
  if (options.partial === true) {
    parts.push('--partial');
  }
  return parts.join(' ');
}

/**
 * `vision-lens benchmark scorecard`: measure the held-out partition and
 * publish the per-sample artifact, the scorecard and the committed pointer.
 *
 * The scorecard is the held-out figure: it measures the `test` partition of
 * the split it is given, the ECE comes from another partition, and the
 * pointer records the digest of every artifact it wrote.
 */
export async function runScorecardCommand(
  options: BenchmarkScorecardOptions,
): Promise<ScorecardCommandOutcome> {
  const splitPath = trackedSplitPath(options.suite, options.splitPath);

  if (!existsSync(splitPath)) {
    logger.warn(`${DATASET_ABSENT_MARKER}: no split manifest at ${splitPath}.`);
    logger.warn(
      'benchmark scorecard skipped: fetch the dataset and generate the gold split first.',
    );
    return { status: 'skipped' };
  }

  const manifest = readJsonFile<SplitManifest>(splitPath);

  // The split fingerprint IS the manifest hash: a scorecard measured against
  // a split it does not name would be attributed to a partition it was never
  // measured on.
  if (
    options.splitFingerprint !== undefined &&
    options.splitFingerprint !== manifest.manifestHash
  ) {
    throw new Error(
      `the split fingerprint '${options.splitFingerprint}' does not match the manifest ` +
        `'${manifest.id}', whose hash is '${manifest.manifestHash}'. Refusing to attribute a ` +
        'scorecard to a split it was not measured against.',
    );
  }

  if (options.predictionsPath === undefined) {
    throw new Error(
      'no predictions: pass --predictions <file> (a JSON array of predictions). ' +
        'The scorecard never invents predictions.',
    );
  }
  if (!existsSync(options.predictionsPath)) {
    throw new Error(`predictions file not found: ${options.predictionsPath}`);
  }
  const predictions = readJsonFile<PredictionItem[]>(options.predictionsPath);

  // The dataset registry is the constitutional gate: the scorecard only
  // exists for a dataset the platform is allowed to use.
  let registry: DatasetRegistry;
  try {
    registry = await loadDatasetRegistry(path.join('datasets', 'registry.json'));
  } catch (error) {
    // The registry is read by its repository-relative path, so the command
    // runs FROM the repository root. A gate that cannot read its input
    // refuses: it never scores without it.
    throw new Error(
      `the dataset registry could not be read at 'datasets/registry.json': ` +
        `${error instanceof Error ? error.message : String(error)}. The command reads the ` +
        'repository files by their repository-relative paths, so it runs FROM the repository ' +
        'root.',
      { cause: error },
    );
  }
  const datasetEntry = findDataset(registry, manifest.datasetId);

  // The constitutional gate itself, the same one the fetch and the normalise
  // paths apply: a dataset recorded as research-only, or one whose license
  // forbids commercial use, may be documented but never scored. The refusal
  // keeps the gate's own wording, so a constitutional refusal is never
  // hidden behind a wrong label.
  try {
    assertDatasetUsable(datasetEntry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('scorecard refused: dataset-not-usable');
    logger.error(message);
    return { status: 'refused', code: 'dataset-not-usable', message };
  }

  const device = scorecardDeviceInput(options.device);

  // The snapshot is resolved BEFORE the scorecard is built, so the scorecard
  // and the recorded command name the SAME snapshot. The default is the
  // current HEAD, which moves: a command that left the default out would
  // reproduce the measurement against another code state.
  const snapshotId = options.snapshotId ?? currentSnapshotId();

  const result = buildScorecard({
    suite: options.suite,
    model: options.model,
    tuple: {
      snapshotId,
      splitFingerprint: options.splitFingerprint ?? manifest.manifestHash,
      modelVersion: options.modelVersion ?? '',
      configFingerprint: options.configFingerprint ?? '',
      // The environment capture is part of the attribution (ADR-008): a
      // scorecard with an EMPTY environment field is not attributed. Only
      // non-secret facts are recorded.
      env: captureEnv(options.env),
    },
    splitManifest: manifest,
    predictions,
    datasetEntry,
    ...(options.calibrationPartition === undefined
      ? {}
      : { calibrationPartition: options.calibrationPartition }),
    ...(device === undefined ? {} : { device }),
    ...(options.minSupport === undefined ? {} : { minSupport: options.minSupport }),
    ...(options.partial === undefined ? {} : { partial: options.partial }),
    assetHashes: computeAssetHashes(manifest, manifest.datasetId),
  });

  if (!result.ok) {
    // A typed failure is a refusal: the scorecard is NOT written and the
    // code is printed, so the caller can act on it.
    logger.error(`scorecard refused: ${result.error.code}`);
    logger.error(result.error.message);
    if (result.error.detail !== undefined) {
      logger.error(result.error.detail);
    }
    return { status: 'refused', code: result.error.code, message: result.error.message };
  }

  const pointerPath =
    options.pointerDir === undefined
      ? defaultScorecardPointerPath(options.suite, options.model)
      : path.join(
          options.pointerDir,
          path.basename(defaultScorecardPointerPath(options.suite, options.model)),
        );

  const written = await writeScorecardArtifacts({
    scorecard: result.scorecard,
    splitManifest: manifest,
    predictions,
    pointerPath,
    ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }),
    reproduce: {
      // The recorded command must be RUNNABLE: it carries every option the
      // scorecard depends on, including the required attribution ones, or it
      // reproduces nothing.
      command: scorecardReproduceCommand(options, splitPath, snapshotId),
    },
  });

  if (!written.ok) {
    logger.error(`scorecard refused: ${written.error.code}`);
    logger.error(written.error.message);
    return { status: 'refused', code: written.error.code, message: written.error.message };
  }

  const scorecard = written.scorecardWithRefs;
  logger.success(`scorecard ${scorecard.scorecardId}`);
  logger.info(`partition: ${scorecard.split.evaluatedPartition}`);
  logger.info(`items scored: ${scorecard.coverage.scored}`);
  for (const metric of scorecard.metrics) {
    logger.info(
      `${metric.name}: ${formatNumber(metric.value)} (n=${metric.n}, ${metric.partition})`,
    );
  }
  logger.info(`per-sample: ${written.perSamplePath}`);
  logger.info(`scorecard: ${written.scorecardPath}`);
  logger.info(`pointer: ${written.pointerPath}`);
  for (const limitation of scorecard.limitations) {
    logger.warn(limitation);
  }
  return {
    status: 'written',
    scorecardId: scorecard.scorecardId,
    pointerPath: written.pointerPath,
  };
}

/**
 * The most recent run artifact of a suite AND model.
 *
 * The gate's `--metrics` has no fixed default path: `run` writes to
 * `benchmarks/results/<runId>/`, and the run id is a hash of the reproduction
 * tuple, so a hardcoded path would never match. Instead the gate looks for
 * the newest artifact belonging to the requested suite and model and uses it.
 *
 * Both keys matter. A baseline is recorded per (suite, model): comparing the
 * metrics of one model against the baseline of another produces a confident,
 * completely meaningless verdict.
 *
 * @returns the path of the artifact, or `undefined` when there is none.
 */
function findLatestRunArtifact(
  suite: string,
  model: string,
  dir: string,
): string | undefined {
  if (!existsSync(dir)) return undefined;
  const candidates: Array<{ path: string; modifiedAt: number }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const reportPath = path.join(dir, entry.name, 'report.json');
    if (!existsSync(reportPath)) continue;
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BenchmarkReport;
      if (report.suite !== suite || report.model !== model) continue;
      candidates.push({ path: reportPath, modifiedAt: statSync(reportPath).mtimeMs });
    } catch {
      // A corrupt artifact must not break the discovery of a good one.
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return candidates[0]?.path;
}

/**
 * `vision-lens benchmark gate` — compare a run against its baseline.
 *
 * @returns the gate result, or `undefined` when the gate was skipped because
 *   the dataset or the run artifact is absent.
 */
export async function runBenchmarkGateCommand(
  options: BenchmarkGateOptions,
): Promise<GateResult | undefined> {
  const resultsDir = path.join('benchmarks', 'results');
  const metricsPath =
    options.metricsPath ?? findLatestRunArtifact(options.suite, options.model, resultsDir);

  if (metricsPath === undefined || !existsSync(metricsPath)) {
    logger.warn(`artifact=absent — no run artifact for suite '${options.suite}'.`);
    logger.warn('gate=skipped — nothing to compare against the baseline.');
    logger.warn(
      `Run 'vision-lens benchmark run --suite ${options.suite} --model-id ${options.model} ...' first, ` +
        'or pass --metrics <report.json>.',
    );
    return undefined;
  }

  const report = readJsonFile<BenchmarkReport>(metricsPath);
  // The artifact must be the one that was asked for. A baseline is recorded
  // per (suite, model), so scoring one model's artifact against another
  // model's baseline produces a confident and completely meaningless verdict.
  if (report.suite !== options.suite || report.model !== options.model) {
    throw new Error(
      `the artifact at '${metricsPath}' is a run of '${report.suite}/${report.model}', but the ` +
        `gate was asked for '${options.suite}/${options.model}'. Refusing to compare them.`,
    );
  }
  const metrics = report.metrics as MetricsResult;
  // The baseline is keyed by (suite, model, model version): a baseline of a
  // different model version is a different model.
  const modelVersion = report.tuple.modelVersion;

  // The artifact's OWN partial flag is honoured: a partial run (a provider
  // outage) must be skipped by the gate, never compared and never failed.
  const partial = options.partial === true || report.partial === true;

  // The split that is currently tracked for the suite. The gate needs it to
  // refuse a number that does not belong to the tracked split: without it the
  // comparison would bless a run measured on a partition the platform no
  // longer tracks. When the split file is absent the check stays inert, so a
  // missing dataset remains a skip and never a failure.
  const splitPath = trackedSplitPath(options.suite, options.splitPath);
  const splitExists = existsSync(splitPath);

  const result = evaluateGate({
    suite: options.suite,
    model: options.model,
    ...(modelVersion === undefined ? {} : { modelVersion }),
    metrics,
    partial,
    // The baseline is the TRACKED artifact — the run report under
    // `benchmarks/results/` is gitignored — so the baseline records the
    // reproduction tuple of the run it was recorded from.
    attribution: {
      ...(report.tuple.snapshotId === undefined ? {} : { snapshotId: report.tuple.snapshotId }),
      ...(report.tuple.splitFingerprint === undefined
        ? {}
        : { splitFingerprint: report.tuple.splitFingerprint }),
      ...(report.tuple.configFingerprint === undefined
        ? {}
        : { configFingerprint: report.tuple.configFingerprint }),
    },
    ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
    ...(options.baselinePath === undefined ? {} : { baselinePath: options.baselinePath }),
    ...(options.updateBaseline === undefined
      ? {}
      : { updateBaseline: options.updateBaseline }),
    ...(options.force === undefined ? {} : { force: options.force }),
    // The split identity check is only meaningful when the tracked split is
    // actually on disk, so it is passed only then.
    ...(splitExists
      ? { currentSplitPath: splitPath, splitsDir: path.dirname(splitPath) }
      : {}),
  });

  if (result.skipped) {
    logger.warn(result.reason);
    return result;
  }

  if (result.passed) {
    logger.success(`gate passed — ${result.reason}`);
  } else {
    logger.error(`gate failed — ${result.reason}`);
    for (const delta of result.deltas) {
      logger.raw(
        `  ${delta.labelKey}: baseline ${formatNumber(delta.baseline)} → ` +
          `current ${formatNumber(delta.current)} (${delta.delta >= 0 ? '+' : ''}${formatNumber(delta.delta)})`,
      );
    }
  }
  return result;
}

/**
 * `vision-lens benchmark report` — print a stored artifact.
 *
 * @returns `false` when the artifact does not exist.
 */
export async function runBenchmarkReportCommand(
  options: BenchmarkReportOptions,
): Promise<boolean> {
  const dir = options.dir ?? path.join('benchmarks', 'results');
  const reportPath = path.join(dir, options.runId, 'report.json');

  if (!existsSync(reportPath)) {
    logger.warn(`${DATASET_ABSENT_MARKER} — no run artifact at ${reportPath}.`);
    return false;
  }

  const report = readJsonFile<BenchmarkReport>(reportPath);
  logger.info(`run: ${report.runId}`);
  logger.info(`suite: ${report.suite} · model: ${report.model}`);
  logger.info(`generated at: ${report.generatedAt}`);
  logger.info(`partial: ${report.partial ? 'yes' : 'no'}`);
  logger.info(`snapshot: ${report.tuple.snapshotId}`);
  logger.info(`split fingerprint: ${report.tuple.splitFingerprint}`);
  logger.info(`model version: ${report.tuple.modelVersion}`);
  logger.info(`config fingerprint: ${report.tuple.configFingerprint}`);
  logger.info(`items scored: ${report.metrics.itemsScored}`);
  logger.info(`macro F1: ${formatNumber(report.metrics.macroF1)}`);
  logger.info(`balanced accuracy: ${formatNumber(report.metrics.balancedAccuracy)}`);
  logger.info(`ECE: ${formatNumber(report.calibration.ece)}`);
  for (const caveat of report.caveats) {
    logger.warn(caveat);
  }
  return true;
}

/** The default gate tolerance, re-exported so the CLI can document it. */
export { DEFAULT_GATE_TOLERANCE };
