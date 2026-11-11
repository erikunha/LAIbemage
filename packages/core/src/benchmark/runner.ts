/**
 * Benchmark runner — spec 003, US3 (FR-005, SC-004).
 *
 * ## What this module is
 *
 * The runner turns a gold split plus a set of predictions into an **attributed**
 * artifact: a JSON report and a Markdown report, both carrying the full
 * reproduction tuple. It is the only sanctioned way to produce a benchmark
 * number in this repository.
 *
 * ## Why the tuple is mandatory
 *
 * ADR-008 (`docs/adr/008-evidence-policy.md`) forbids unattributed reports: a
 * metric without the code snapshot, the split fingerprint, the model version,
 * the config fingerprint and the environment is a hypothesis, not a result.
 * `runBenchmark` therefore **refuses to emit anything** when the tuple is
 * missing — it does not write a partial file, it does not write a file with
 * placeholder values, it throws and names every missing field.
 *
 * ## Layering
 *
 * The metrics themselves live in `metrics.ts` / `calibration.ts` and are pure.
 * This module owns only: validation, orchestration, and artifact emission.
 * It never recomputes a metric — a metric computed twice is a metric that
 * drifts, and specs 006/007 call the very same functions this runner calls.
 *
 * ## Determinism
 *
 * The report payload is byte-stable for identical inputs: `runId` is derived
 * from the tuple (not from the clock), and the only wall-clock value in the
 * artifact is `generatedAt`, which lives in its own top-level field so a
 * byte-stability comparison can exclude it explicitly.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeCalibration, type CalibrationResult } from './calibration.js';
import {
  scoreMetrics,
  type GoldItem,
  type MetricsResult,
  type PredictionItem,
} from './metrics.js';
import {
  validateSplitManifestHashes,
  type SplitManifest,
} from './splits.js';
import { sha256Hex } from './splits.js';

/** Schema version of the emitted report artifact. Bump on a breaking change. */
export const BENCHMARK_REPORT_SCHEMA_VERSION = 1;

/** Default number of gold samples a class needs before it is scored. */
export const DEFAULT_MIN_SAMPLES = 30;

/**
 * The reproduction tuple: everything needed to reproduce a number.
 *
 * Every field is required. A report that carries one of them is not
 * attributable, and ADR-008 says such a report must not exist.
 */
export interface ReproductionTuple {
  /** Identifier of the code snapshot the run was produced from (e.g. a commit sha). */
  readonly snapshotId: string;
  /** The split manifest hash the run was scored against. */
  readonly splitFingerprint: string;
  /** The model identity AND version (e.g. `model:<id>@<version>`). */
  readonly modelVersion: string;
  /** The config fingerprint the run used. */
  readonly configFingerprint: string;
  /** The captured environment. Never contains secrets — see `captureEnv`. */
  readonly env: Readonly<Record<string, string>>;
}

/** Options of {@link runBenchmark}. */
export interface RunBenchmarkOptions {
  /** The suite the run belongs to (e.g. `visa-subset`). */
  readonly suite: string;
  /** The model the run scored (e.g. `gpt-4o`). */
  readonly model: string;
  /** The gold items to score against. */
  readonly gold: readonly GoldItem[];
  /** The predictions to score. */
  readonly predictions: readonly PredictionItem[];
  /**
   * The reproduction tuple. `undefined` (or a partial tuple) is REFUSED —
   * that refusal is the enforcement point of ADR-008.
   */
  readonly tuple: Partial<ReproductionTuple> | undefined;
  /** The split manifest the run was scored against. Enables the integrity gate. */
  readonly splitManifest?: SplitManifest;
  /**
   * The sha256 of every scored item, as recomputed from the actual files.
   * When present, the runner compares them with the manifest and refuses to
   * score an image set whose hashes diverge.
   */
  readonly assetHashes?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** Minimum gold samples per class. Classes below it are excluded, loudly. */
  readonly minSamples?: number;
  /** Marks the run as partial (e.g. a provider outage). */
  readonly partial?: boolean;
  /** Extra caveats to record (e.g. gold-label noise). */
  readonly caveats?: readonly string[];
  /** Where the artifacts are written. Defaults to `benchmarks/results`. */
  readonly outputDir?: string;
  /** Injectable clock, so tests get byte-stable artifacts. */
  readonly now?: Date;
}

/** The result of one benchmark run. */
export interface BenchmarkRunResult {
  /** Deterministic id of the run (derived from the tuple, never from the clock). */
  readonly runId: string;
  /** The complete reproduction tuple. */
  readonly tuple: ReproductionTuple;
  /** The scored metrics. */
  readonly metrics: MetricsResult;
  /** The calibration report. */
  readonly calibration: CalibrationResult;
  /** Every caveat the report must carry (never a silent exclusion). */
  readonly caveats: readonly string[];
  /** Whether the run is partial. */
  readonly partial: boolean;
  /** Absolute path of the JSON artifact. */
  readonly reportJsonPath: string;
  /** Absolute path of the Markdown artifact. */
  readonly reportMarkdownPath: string;
}

/** The JSON artifact as it is written to disk. */
export interface BenchmarkReport {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly suite: string;
  readonly model: string;
  /** The only wall-clock value in the artifact — excluded from byte-stability checks. */
  readonly generatedAt: string;
  readonly partial: boolean;
  readonly tuple: ReproductionTuple;
  readonly metrics: MetricsResult;
  readonly calibration: CalibrationResult;
  readonly caveats: readonly string[];
}

/**
 * Validate a reproduction tuple and return it complete.
 *
 * @throws Error naming EVERY missing field at once — a caller that fixes one
 * field and re-runs should not have to discover the next missing one.
 */
export function assertReproductionTuple(
  tuple: Partial<ReproductionTuple> | undefined,
): ReproductionTuple {
  if (tuple === undefined || tuple === null) {
    throw new Error(
      'missing reproduction tuple: a benchmark report cannot be emitted without the ' +
        'snapshot id, the split fingerprint, the model version, the config fingerprint ' +
        'and the environment capture (ADR-008). Missing: snapshotId, splitFingerprint, ' +
        'modelVersion, configFingerprint, env.',
    );
  }

  const missing: string[] = [];
  const requireString = (value: unknown, field: string): void => {
    if (typeof value !== 'string' || value.trim() === '') missing.push(field);
  };

  requireString(tuple.snapshotId, 'snapshotId');
  requireString(tuple.splitFingerprint, 'splitFingerprint');
  requireString(tuple.modelVersion, 'modelVersion');
  requireString(tuple.configFingerprint, 'configFingerprint');
  if (tuple.env === undefined || tuple.env === null) missing.push('env');

  if (missing.length > 0) {
    throw new Error(
      `missing reproduction tuple field(s): ${missing.join(', ')}. ` +
        'A benchmark report is only emitted with a complete tuple (ADR-008).',
    );
  }

  return {
    snapshotId: tuple.snapshotId as string,
    splitFingerprint: tuple.splitFingerprint as string,
    modelVersion: tuple.modelVersion as string,
    configFingerprint: tuple.configFingerprint as string,
    env: tuple.env as Readonly<Record<string, string>>,
  };
}

/**
 * The deterministic id of a run.
 *
 * Derived from the tuple, the suite, the model AND the digest of the
 * predictions — never from the clock. Two consequences, both intended:
 *
 *  - re-running the same evaluation reproduces the same artifact directory
 *    instead of scattering runs over time-based names;
 *  - two DIFFERENT prediction sets never share an artifact directory, so a
 *    second run cannot silently overwrite the first one's evidence.
 *
 * @param predictionDigest Digest of the prediction set; empty when the caller
 *   has no predictions to hash (the digest is then part of the id as such).
 */
export function computeRunId(
  tuple: ReproductionTuple,
  suite: string,
  model: string,
  predictionDigest = '',
): string {
  const fingerprint = [
    tuple.snapshotId,
    tuple.splitFingerprint,
    tuple.modelVersion,
    tuple.configFingerprint,
    suite,
    model,
    predictionDigest,
  ].join('|');
  return `${suite}-${model}-${sha256Hex(fingerprint).slice(0, 12)}`;
}

/**
 * The digest of a prediction set.
 *
 * The predictions are sorted by id first, so the digest identifies the SET of
 * predictions rather than the order they happened to arrive in.
 */
export function computePredictionDigest(
  predictions: readonly PredictionItem[],
): string {
  const sorted = [...predictions]
    .map((prediction) => ({
      id: prediction.id,
      labelKey: prediction.labelKey,
      probability: prediction.probability ?? null,
      latencyMs: prediction.latencyMs ?? null,
      costUsd: prediction.costUsd ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex(JSON.stringify(sorted));
}

/**
 * The environment capture a report carries.
 *
 * Only non-secret facts are recorded: the runtime version and the platform.
 * API keys, tokens and any other credential must never reach an artifact —
 * artifacts get committed, copied and pasted.
 */
export function captureEnv(
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    ...extra,
  };
}

/** Thrown when the integrity gate refuses to score an image set. */
export class BenchmarkIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkIntegrityError';
  }
}

function toHashMap(
  hashes: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
): Map<string, string> {
  if (hashes === undefined) return new Map();
  if (hashes instanceof Map) return new Map(hashes);
  return new Map(Object.entries(hashes));
}

/**
 * The integrity gate.
 *
 * Two independent checks, both of which abort the run:
 *
 *  1. **Manifest tamper** — the manifest's own hash is recomputed from its
 *     content and compared with the hash it claims. A manifest that was edited
 *     after it was generated is refused by name.
 *  2. **Asset divergence** — every scored item must be known to the manifest,
 *     and the sha256 of the actual bytes must match the manifest's. An image
 *     that changed under the manifest's feet is refused by item id.
 *
 * @returns caveats describing what could NOT be verified. An integrity gate
 *   that silently skips the check it could not perform is worse than no gate:
 *   the caller would believe the bytes were verified.
 */
function assertIntegrity(
  manifest: SplitManifest | undefined,
  gold: readonly GoldItem[],
  assetHashes: ReadonlyMap<string, string>,
): string[] {
  if (manifest === undefined) return [];

  const validation = validateSplitManifestHashes(manifest);
  const hashDivergence = validation.divergences.find(
    (divergence) => divergence.kind === 'manifest-hash-mismatch',
  );
  if (hashDivergence !== undefined) {
    throw new BenchmarkIntegrityError(
      `split manifest '${manifest.id}' failed its integrity check: ${hashDivergence.message} ` +
        'Refusing to score against a tampered manifest.',
    );
  }

  const byId = new Map(manifest.assignments.map((assignment) => [assignment.id, assignment]));

  let unverified = 0;
  for (const item of gold) {
    const assignment = byId.get(item.id);
    if (assignment === undefined) {
      throw new BenchmarkIntegrityError(
        `gold item '${item.id}' is not part of the split manifest '${manifest.id}'. ` +
          'Refusing to score an image set that diverges from the manifest.',
      );
    }
    const actual = assetHashes.get(item.id);
    if (actual === undefined) {
      unverified += 1;
      continue;
    }
    if (actual !== assignment.sha256) {
      throw new BenchmarkIntegrityError(
        `image '${item.id}' does not match the split manifest: expected sha256 ` +
          `${assignment.sha256}, got ${actual}. Refusing to score an image set whose ` +
          'hashes diverge from the manifest.',
      );
    }
  }

  if (unverified > 0) {
    return [
      `The image bytes of ${unverified} scored item(s) were NOT verified against the split ` +
        'manifest: no sha256 was supplied for them. The manifest hash itself was verified, ' +
        'but the bytes behind these items were not.',
    ];
  }
  return [];
}

/**
 * Render the Markdown report.
 *
 * The Markdown renders the SAME numbers as the JSON: a report whose two
 * artifacts disagree is a report nobody can trust.
 */
export function renderMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# Benchmark report — ${report.suite} / ${report.model}`);
  lines.push('');
  lines.push(`- **Run id**: \`${report.runId}\``);
  lines.push(`- **Generated at**: ${report.generatedAt}`);
  lines.push(`- **Partial run**: ${report.partial ? 'yes' : 'no'}`);
  lines.push('');

  lines.push('## Reproduction tuple');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Snapshot id | \`${report.tuple.snapshotId}\` |`);
  lines.push(`| Split fingerprint | \`${report.tuple.splitFingerprint}\` |`);
  lines.push(`| Model version | \`${report.tuple.modelVersion}\` |`);
  lines.push(`| Config fingerprint | \`${report.tuple.configFingerprint}\` |`);
  lines.push(`| Environment | ${Object.entries(report.tuple.env)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')} |`);
  lines.push('');

  lines.push('## Headline');
  lines.push('');
  lines.push(`- Items scored: **${report.metrics.itemsScored}**`);
  lines.push(`- Correct: **${report.metrics.correct}**`);
  lines.push(`- Macro F1: **${report.metrics.macroF1.toFixed(4)}**`);
  lines.push(`- Balanced accuracy: **${report.metrics.balancedAccuracy.toFixed(4)}**`);
  lines.push(`- Expected calibration error: **${report.calibration.ece.toFixed(4)}**`);
  lines.push(`- Latency p50 / p95: **${report.metrics.latency.p50Ms} ms** / **${report.metrics.latency.p95Ms} ms**`);
  lines.push(
    `- Cost per image: **${report.metrics.cost.costPerImageUsd.toFixed(6)} USD** ` +
      `(${report.metrics.cost.itemsWithCost} priced item(s))`,
  );
  lines.push('');

  lines.push('## Per-class metrics');
  lines.push('');
  lines.push('| Class | Support | Predicted | TP | FP | FN | Precision | Recall | F1 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const metrics of report.metrics.perClass) {
    lines.push(
      `| ${metrics.labelKey} | ${metrics.support} | ${metrics.predicted} | ` +
        `${metrics.truePositives} | ${metrics.falsePositives} | ${metrics.falseNegatives} | ` +
        `${metrics.precision.toFixed(4)} | ${metrics.recall.toFixed(4)} | ${metrics.f1.toFixed(4)} |`,
    );
  }
  lines.push('');

  lines.push('## Confusion matrix');
  lines.push('');
  const labels = report.metrics.confusion.labels;
  lines.push(`| gold \\ predicted | ${labels.join(' | ')} |`);
  lines.push(`|---|${labels.map(() => '---').join('|')}|`);
  for (const goldLabel of labels) {
    const row = report.metrics.confusion.rows[goldLabel] ?? {};
    lines.push(
      `| ${goldLabel} | ${labels.map((predicted) => String(row[predicted] ?? 0)).join(' | ')} |`,
    );
  }
  lines.push('');

  lines.push('## Calibration (reliability bins)');
  lines.push('');
  lines.push('| Bin | Range | Count | Mean confidence | Accuracy |');
  lines.push('|---|---|---|---|---|');
  for (const bin of report.calibration.bins) {
    // The bins are half-open [lower, upper) — only the LAST one is closed at
    // 1.0. Rendering them all as closed would misdescribe the convention.
    const isLast = bin.index === report.calibration.bins.length - 1;
    const range = isLast
      ? `[${bin.lower.toFixed(1)}, ${bin.upper.toFixed(1)}]`
      : `[${bin.lower.toFixed(1)}, ${bin.upper.toFixed(1)})`;
    lines.push(
      `| ${bin.index} | ${range} | ${bin.count} | ` +
        `${bin.meanConfidence.toFixed(4)} | ${bin.accuracy.toFixed(4)} |`,
    );
  }
  lines.push('');

  if (report.metrics.unseenPredictedLabels.length > 0) {
    lines.push('## Unseen predicted labels');
    lines.push('');
    lines.push('| Label | Count |');
    lines.push('|---|---|');
    for (const unseen of report.metrics.unseenPredictedLabels) {
      lines.push(`| ${unseen.labelKey} | ${unseen.count} |`);
    }
    lines.push('');
  }

  lines.push('## Caveats');
  lines.push('');
  if (report.caveats.length === 0) {
    lines.push('_None._');
  } else {
    for (const caveat of report.caveats) lines.push(`- ${caveat}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/**
 * Run a benchmark and emit its artifacts.
 *
 * The order of operations matters and is deliberate:
 *
 *  1. the reproduction tuple is validated FIRST — a missing tuple must not
 *     even touch the filesystem;
 *  2. the integrity gate runs before any metric is computed — a tampered
 *     manifest must not produce a number;
 *  3. the artifacts are written LAST, after every number exists.
 *
 * @throws Error when the tuple is incomplete; `BenchmarkIntegrityError` when
 *   the image set diverges from the manifest.
 */
export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkRunResult> {
  const tuple = assertReproductionTuple(options.tuple);
  const assetHashes = toHashMap(options.assetHashes);
  const integrityCaveats = assertIntegrity(options.splitManifest, options.gold, assetHashes);

  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const metrics = scoreMetrics(options.gold, options.predictions, { minSamples });
  const calibration = computeCalibration(options.gold, options.predictions);

  const caveats: string[] = [...metrics.caveats, ...integrityCaveats];
  if (options.partial === true) {
    caveats.push(
      'This run is PARTIAL: the scoring set was incomplete (e.g. a provider outage). ' +
        'A partial run is never compared against a baseline by the gate.',
    );
  }
  caveats.push(...(options.caveats ?? []));

  const runId = computeRunId(
    tuple,
    options.suite,
    options.model,
    computePredictionDigest(options.predictions),
  );
  const now = options.now ?? new Date();
  const report: BenchmarkReport = {
    schemaVersion: BENCHMARK_REPORT_SCHEMA_VERSION,
    runId,
    suite: options.suite,
    model: options.model,
    generatedAt: now.toISOString(),
    partial: options.partial === true,
    tuple,
    metrics,
    calibration,
    caveats,
  };

  const outputDir = options.outputDir ?? path.join('benchmarks', 'results');
  const runDir = path.join(outputDir, runId);
  await mkdir(runDir, { recursive: true });

  const reportJsonPath = path.join(runDir, 'report.json');
  const reportMarkdownPath = path.join(runDir, 'report.md');
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(reportMarkdownPath, renderMarkdownReport(report), 'utf8');

  return {
    runId,
    tuple,
    metrics,
    calibration,
    caveats,
    partial: options.partial === true,
    reportJsonPath,
    reportMarkdownPath,
  };
}
