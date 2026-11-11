/**
 * `vision-lens benchmark run|gate|report` — the spec-003 benchmark surface (US3, US4).
 *
 * ## The three commands
 *
 *  - `run`   — score a prediction set against a gold split and emit the
 *              attributed artifacts under `benchmarks/results/<runId>/`.
 *  - `gate`  — compare a run against the stored baseline and fail the build
 *              when the macro F1 regressed beyond the tolerance.
 *  - `report`— print a stored artifact as a compact summary.
 *
 * ## What this command refuses to do
 *
 * It never downloads a dataset, never invents a number and never emits a
 * report without a reproduction tuple. When the dataset (or the split) is
 * absent it prints an explicit `dataset=absent` marker and exits cleanly —
 * a missing dataset is a skip, not a failure, and it is certainly not a
 * reason to fabricate a score.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  BenchmarkReport,
  GateResult,
  GoldItem,
  MetricsResult,
  PredictionItem,
  SplitAssignment,
  SplitManifest,
} from '@vision-lens/core/benchmark';
import {
  captureEnv,
  evaluateGate,
  runBenchmark,
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
