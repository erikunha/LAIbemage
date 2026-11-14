/**
 * The evaluation scorecard v2 - spec 022 (VLN-008).
 *
 * ## What this module is
 *
 * The benchmark runner scores EVERY gold item of the manifest it is handed,
 * so a run over the tracked v2 split is a 700-item whole-set figure. This
 * module turns the locked `test` partition of that split into a publishable,
 * attributable number: a NEW artifact beside the existing report, with its
 * own protocol version, its own partition selection and its own refusal
 * vocabulary. The existing report artifact is not changed (FR-016).
 *
 * ## Pinned rules
 *
 * Partition ......... the scorecard evaluates the `test` partition of the
 *                     split manifest, selected BY NAME, and records the
 *                     partition, its item count and its digest. No `train`
 *                     or `val` item enters the metric computation (FR-002).
 * Three digests ..... `manifestSha256` is the identity of the split FILE
 *                     (`computeManifestHash`), `partitionFingerprint` is the
 *                     digest of the whole partition, and
 *                     `testSplitFingerprint` is the digest of the TEST
 *                     assignments alone. The third one is simply
 *                     `computePartitionFingerprint` over the selected
 *                     assignments: the same construction over a smaller set.
 *                     The three are never interchanged.
 * Metric records .... every metric is an object carrying `value`, `n` and
 *                     `partition`. The schema offers no bare numeric
 *                     accuracy field: a percentage without a count and a
 *                     subset is not representable (FR-004).
 * Calibration ....... the ECE is computed on a partition that is NOT the
 *                     test partition. Naming `test` as the calibration
 *                     source is a typed refusal (FR-007). The probability
 *                     source is recorded: a self-declared confidence is
 *                     flagged as `raw_declared` and raises a limitation
 *                     (ADR-008).
 * Support rule ...... the scorecard carries its own explicit support rule
 *                     (default 10), lower than the runner's whole-set
 *                     default of 30 because the test partition holds 20
 *                     items per defect class: the runner default would
 *                     exclude every defect class and leave a one-class
 *                     macro F1 wearing a five-class label. The runner's
 *                     default is not changed. A class below the rule is
 *                     excluded from the per-class rows and from the macro
 *                     F1 and is named with its support in the limitations
 *                     (FR-006).
 * Intervals ......... confidence intervals come from a bootstrap whose
 *                     method, resample count and seed derivation are
 *                     recorded. The generator is the repository's
 *                     `mulberry32`; `Math.random` is never used. The seed
 *                     is derived from the protocol version and the test
 *                     partition digest, so the same partition always yields
 *                     the same interval (FR-009). A split that enforces
 *                     capture groups gets a group-aware bootstrap; the
 *                     tracked split does not, so it gets a class-stratified
 *                     item bootstrap and an explicit limitation.
 * Content id ........ `scorecardId` is derived from the content (protocol
 *                     version, split digests, model version, config
 *                     fingerprint, prediction digest, calibration partition,
 *                     bootstrap parameters), never from the clock. The only
 *                     wall-clock value is `generatedAt`, in its own field,
 *                     so a byte-stability comparison can exclude it
 *                     (FR-018, the runner's precedent).
 * Unknown ........... a field the caller cannot supply honestly (device,
 *                     model size) is recorded as `unknown` with a
 *                     limitation, never fabricated from the platform string
 *                     (FR-010).
 * Artifacts ......... the per-sample artifact lands under the gitignored
 *                     results directory; a committed pointer file records
 *                     each artifact's relative path, sha256, byte count and
 *                     row count plus the scorecard digest, so a published
 *                     scorecard is verifiable without committing megabytes
 *                     (FR-015).
 *
 * ## Failure model
 *
 * The builder consumes untrusted external inputs (the manifest, the
 * prediction set, the calibration set, the device string, the baseline
 * file) and returns a typed failure for each of them instead of throwing
 * (FR-017). Two enforcement points keep their shipped throwing behavior on
 * purpose: the reproduction tuple (validated by the shipped
 * `assertReproductionTuple`, the runner's own enforcement point) and the
 * dataset license gate (`assertDatasetLicensed`, the constitutional gate
 * the registry applies everywhere). Neither is an enumerated untrusted
 * input of FR-017; swallowing either into a generic code would hide a
 * constitutional refusal behind a wrong label.
 */

import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeCalibration, type CalibrationBin } from './calibration.js';
import type { BaselineEntry, BaselineFile } from './gate.js';
import {
  computeBalancedAccuracy,
  computeLatencySummary,
  computeCostSummary,
  computeMacroF1,
  computePerClassMetrics,
  joinGoldAndPredictions,
  percentile,
  scoreMetrics,
  type ConfusionMatrix,
  type GoldItem,
  type PredictionItem,
  type ScoredItem,
} from './metrics.js';
import {
  assertDatasetLicensed,
  type DatasetRegistryEntry,
} from './registry.js';
import {
  assertReproductionTuple,
  computePredictionDigest,
  DEFAULT_MIN_SAMPLES,
  type ReproductionTuple,
} from './runner.js';
import {
  compareIds,
  computePartitionFingerprint,
  fnv1a32,
  mulberry32,
  sha256Hex,
  SPLIT_NAMES,
  validateSplitManifestHashes,
  type SplitAssignment,
  type SplitManifest,
  type SplitName,
} from './splits.js';
import { labelKeyOf } from './taxonomy.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The protocol version of the scorecard. Bumped on any breaking change to
 * the scorecard schema or semantics, so a claim made under an older
 * protocol is never silently re-stamped as a new one (FR-001, FR-016).
 */
export const SCORECARD_PROTOCOL_VERSION = 'scorecard-v1';

/** The schema version of the scorecard artifact's own shape (FR-001). */
export const SCORECARD_SCHEMA_VERSION = 1;

/**
 * The partition the scorecard evaluates. The selection is the `test`
 * partition of the tracked split and nothing else (FR-002).
 */
export const SCORECARD_EVALUATED_PARTITION: SplitName = 'test';

/**
 * The partition the ECE is computed on when the caller names none. The
 * tracked split has exactly three partitions, so `val` is the calibration
 * source until the split contract grows a dedicated one.
 */
export const SCORECARD_DEFAULT_CALIBRATION_PARTITION: SplitName = 'val';

/**
 * The scorecard's explicit support rule: the minimum gold support a class
 * needs inside the EVALUATED PARTITION to be scored.
 *
 * WHY lower than the runner's `DEFAULT_MIN_SAMPLES` of 30: the test
 * partition of the tracked split holds 20 items per defect class, so the
 * runner default would exclude all four defect classes and the macro F1
 * would be the F1 of the single `normal` class. The rule is recorded in the
 * artifact and every excluded class is named with its support in the
 * limitations (FR-006). The runner's default is not changed.
 */
export const SCORECARD_DEFAULT_MIN_SUPPORT = 10;

/** The default number of bootstrap resamples behind every interval (FR-009). */
export const SCORECARD_DEFAULT_RESAMPLES = 1000;

/** The interval bounds: the 2.5th and the 97.5th percentile of the resamples. */
export const SCORECARD_INTERVAL_QUANTILES = { lower: 0.025, upper: 0.975 } as const;

/**
 * The metric regime of a scorecard: the numbers were computed on the `test`
 * partition alone. A whole-set runner number is a different regime, and the
 * two are never compared (FR-014).
 */
export const SCORECARD_REGIME = 'test-partition';

/** The metric regime of a whole-set runner number (all manifest items scored). */
export const WHOLE_SET_REGIME = 'whole-set';

/** Where the estimated cost's rates come from: the repository's pricing table. */
export const SCORECARD_PRICING_SOURCE = 'packages/core/src/utils/cost.ts PROVIDER_PRICING';

/** The default directory the per-sample artifacts are written under (gitignored). */
export const SCORECARD_DEFAULT_RESULTS_DIR = path.join('benchmarks', 'results');

/** The default directory the committed pointer files are written under (tracked). */
export const SCORECARD_DEFAULT_POINTER_DIR = path.join('benchmarks', 'scorecards');

/** The column header row of the per-sample artifact (the pack asks for it). */
export const PER_SAMPLE_ARTIFACT_COLUMNS = [
  'id',
  'goldLabelKey',
  'predictedLabelKey',
  'correct',
  'confidence',
  'latencyMs',
  'costUsd',
  'partition',
] as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The typed refusal vocabulary of the scorecard (spec 022, Key Entities).
 * A caller switches on the code; the message carries the detail.
 */
export type ScorecardErrorCode =
  | 'test-partition-empty'
  | 'test-partition-missing'
  | 'calibration-partition-empty'
  | 'calibration-partition-is-test'
  | 'manifest-digest-mismatch'
  | 'prediction-set-invalid'
  | 'baseline-regime-mismatch'
  | 'artifact-write-failed';

/** Every error code, in the order the spec lists them. */
export const SCORECARD_ERROR_CODES: readonly ScorecardErrorCode[] = [
  'test-partition-empty',
  'test-partition-missing',
  'calibration-partition-empty',
  'calibration-partition-is-test',
  'manifest-digest-mismatch',
  'prediction-set-invalid',
  'baseline-regime-mismatch',
  'artifact-write-failed',
];

/** One typed failure of the scorecard builder or of an artifact check. */
export interface ScorecardError {
  readonly code: ScorecardErrorCode;
  readonly message: string;
  readonly detail?: string;
}

/** The typed result: a success carrying the scorecard, or a typed failure. */
export type ScorecardResult =
  | { readonly ok: true; readonly scorecard: Scorecard }
  | { readonly ok: false; readonly error: ScorecardError };

/** Construct one typed error. */
function errorOf(code: ScorecardErrorCode, message: string, detail?: string): ScorecardError {
  return detail === undefined ? { code, message } : { code, message, detail };
}

/** Convenience constructor for a typed failure result. */
function failure(code: ScorecardErrorCode, message: string, detail?: string): ScorecardResult {
  return { ok: false, error: errorOf(code, message, detail) };
}

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

/** How the probabilities behind the ECE were produced (ADR-008). */
export type ProbabilitySource = 'raw_declared' | 'calibrated';

/** The resampling unit of a bootstrap interval. */
export type BootstrapUnit = 'item' | 'capture-group';

/** The bootstrap method, chosen by the split's `groupBasis` (FR-009). */
export type BootstrapMethod = 'stratified-item-bootstrap' | 'group-aware-bootstrap';

/** A confidence interval whose production is fully recorded (FR-009). */
export interface ScorecardInterval {
  readonly lower: number;
  readonly upper: number;
  readonly method: BootstrapMethod;
  readonly resamples: number;
  /** The numeric seed the resampling consumed (derived, never typed). */
  readonly seed: number;
  /** The recorded derivation of the seed, so a reader can recompute it. */
  readonly seedDerivation: string;
  readonly unit: BootstrapUnit;
  /** The number of resampled units (capture groups) when the unit is the group. */
  readonly groups?: number;
}

/**
 * One metric record. A bare number is not representable: `n` and `partition`
 * are structurally required, so a percentage without a count and a subset
 * cannot exist in the schema (FR-004).
 */
export interface ScorecardMetric {
  /** Which metric this record is, e.g. `macroF1`. */
  readonly name: string;
  readonly value: number;
  readonly n: number;
  readonly partition: string;
  readonly ci?: ScorecardInterval;
  readonly ciMethod?: BootstrapMethod;
  /** The gold support behind the value, when the metric has one. */
  readonly support?: number;
}

/** One per-class row of the evaluated partition. */
export interface ScorecardPerClassRow {
  readonly labelKey: string;
  readonly support: number;
  readonly predicted: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly ci?: ScorecardInterval;
  /**
   * True when the class support is below the runner's whole-set default
   * (`DEFAULT_MIN_SAMPLES`, 30): the class-level result is exploratory and
   * is labelled so (spec 022 US3). The class still meets the scorecard's own
   * support rule, otherwise it would not have a row at all.
   */
  readonly insufficientSupport?: boolean;
}

/** The calibration block: the ECE and everything needed to judge it (FR-008). */
export interface ScorecardCalibration {
  readonly ece: number;
  readonly bins: readonly CalibrationBin[];
  readonly partition: string;
  readonly n: number;
  /** The digest of the calibration partition alone (same construction as the test digest). */
  readonly partitionDigest: string;
  readonly probabilitySource: ProbabilitySource;
  readonly calibratorRef?: string;
}

/** The cost block: measured and estimated cost are two fields, never one (FR-011). */
export interface ScorecardCost {
  readonly measured?: { readonly totalUsd: number };
  readonly estimated?: {
    readonly totalUsd: number;
    readonly rateAsOf: string;
    readonly source: string;
  };
  readonly currency: 'USD';
  /** The rate as-of date the caller confirmed; `unknown` when no estimate is carried. */
  readonly rateAsOf: string;
  readonly itemsWithCost: number;
  readonly itemsWithoutCost: number;
  /** No loss matrix exists yet, so the business-loss figure is not estimated. */
  readonly errorLoss: 'not_estimated';
}

/** The latency block: p50/p95 plus the cold/warm and model-load split (FR-012). */
export interface ScorecardLatency {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly coldMs?: number;
  readonly warmMs?: number;
  readonly modelLoadMs?: number;
}

/** What the scorecard knows about the device it was produced on (FR-010). */
export interface ScorecardDevice {
  readonly kind: 'cpu' | 'mps' | 'cuda' | 'unknown';
  readonly name: string;
  readonly memoryGb?: number;
}

/** The dataset attribution block, from the dataset registry. */
export interface ScorecardDataset {
  readonly id: string;
  readonly version: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly attribution: string;
}

/** The split block: which partition was evaluated, and on what terms. */
export interface ScorecardSplit {
  readonly manifestId: string;
  readonly strategy: 'grouped' | 'stratified';
  readonly evaluatedPartition: string;
  readonly calibrationPartition: string;
  readonly counts: { readonly train: number; readonly val: number; readonly test: number };
  readonly captureGroupsEnforced: boolean;
}

/** The coverage block: what was expected, what was scored, what was missing (FR-005). */
export interface ScorecardCoverage {
  readonly expected: number;
  readonly scored: number;
  readonly missing: number;
  readonly coverage: number;
  /** Predictions whose id matches no manifest item: reported, never scored. */
  readonly orphanPredictions: number;
}

/** One artifact the pointer file records (FR-015). */
export interface ArtifactRef {
  readonly role: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
  readonly tracked: boolean;
}

/** One prior baseline of the suite's family, listed for disclosure (FR-013). */
export interface PriorBaselineReference {
  readonly suite: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly macroF1: number;
  readonly splitFingerprint: string;
  readonly status: 'active' | 'retired';
  /** False for every whole-set number, true only for test-partition numbers. */
  readonly holdout: boolean;
  readonly regime: string;
  readonly retiredReason?: string;
}

/** The scorecard artifact (spec 022, Key Entities; the pack's field list). */
export interface Scorecard {
  readonly protocolVersion: string;
  readonly schemaVersion: number;
  readonly scorecardId: string;
  /** The only wall-clock value in the artifact, in its own field (FR-018). */
  readonly generatedAt: string;
  readonly partial: boolean;

  readonly suite: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly configFingerprint: string;
  readonly snapshotId: string;

  readonly dataset: ScorecardDataset;
  readonly device: ScorecardDevice;
  readonly modelSize: number | 'unknown';
  readonly split: ScorecardSplit;

  /** The metric regime of the scorecard; the gate compares regimes (FR-014). */
  readonly regime: string;
  /** The explicit support rule the per-class rows were computed under (FR-006). */
  readonly supportRule: number;

  readonly testSplitFingerprint: string;
  readonly manifestSha256: string;

  readonly metrics: readonly ScorecardMetric[];
  readonly perClass: readonly ScorecardPerClassRow[];
  readonly confusion: ConfusionMatrix;
  readonly calibration: ScorecardCalibration;
  readonly cost: ScorecardCost;
  readonly latency: ScorecardLatency;
  readonly coverage: ScorecardCoverage;

  readonly limitations: readonly string[];
  readonly priorBaselines: readonly PriorBaselineReference[];
  readonly artifactRefs: readonly ArtifactRef[];
  /** The shipped reproduction tuple, unchanged (the runner's own type). */
  readonly reproduction: ReproductionTuple;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Caller-supplied device facts. Anything absent is recorded as `unknown`. */
export interface ScorecardDeviceInput {
  readonly kind?: 'cpu' | 'mps' | 'cuda' | 'unknown';
  readonly name?: string;
  readonly memoryGb?: number;
}

/** Caller-confirmed cost estimate: the number, and the date its rates hold for. */
export interface ScorecardEstimatedCostInput {
  readonly totalUsd: number;
  readonly rateAsOf: string;
}

/** Caller-measured latency extras, separated from the per-item timings. */
export interface ScorecardLatencyExtrasInput {
  readonly coldMs?: number;
  readonly warmMs?: number;
  readonly modelLoadMs?: number;
}

/** Options of {@link buildScorecard}. */
export interface BuildScorecardOptions {
  /** The suite the scorecard belongs to (e.g. `visa-subset.v2`). */
  readonly suite: string;
  /** The model the predictions came from (e.g. `gpt-4o`). */
  readonly model: string;
  /**
   * The reproduction tuple, validated by the shipped `assertReproductionTuple`.
   * `splitFingerprint` must carry the manifest hash of `splitManifest`.
   */
  readonly tuple: ReproductionTuple;
  /** The split manifest whose `test` partition is scored. Untrusted, validated. */
  readonly splitManifest: SplitManifest;
  /** The prediction set. Untrusted: validated, then joined per partition. */
  readonly predictions: readonly PredictionItem[];
  /** The dataset registry entry of the manifest's dataset (the license gate). */
  readonly datasetEntry: DatasetRegistryEntry;
  /** The partition the ECE is computed on. Defaults to `val`; `test` is refused. */
  readonly calibrationPartition?: string;
  /** Where the probabilities came from. Defaults to `raw_declared` (ADR-008). */
  readonly probabilitySource?: ProbabilitySource;
  /** The calibrator reference, when the probabilities are calibrated. */
  readonly calibratorRef?: string;
  /** Device facts; absent fields are recorded as `unknown` with a limitation. */
  readonly device?: ScorecardDeviceInput;
  /** Model size in bytes; absent is recorded as `unknown` with a limitation. */
  readonly modelSizeBytes?: number;
  /** The caller-confirmed cost estimate and its rate as-of date (FR-011). */
  readonly estimatedCost?: ScorecardEstimatedCostInput;
  /** Cold/warm and model-load timings the per-item latencies cannot show (FR-012). */
  readonly latencyExtras?: ScorecardLatencyExtrasInput;
  /** The baseline file of the suite's family, read with the shipped reader. */
  readonly baselineFile?: BaselineFile;
  /**
   * Capture-group keys by item id. Used only when the split enforces capture
   * groups (the group-aware bootstrap resamples groups, and a manifest's
   * assignments carry no group field). Without it the interval falls back to
   * the item bootstrap and says so in the limitations.
   */
  readonly captureGroups?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** The explicit support rule. Defaults to {@link SCORECARD_DEFAULT_MIN_SUPPORT}. */
  readonly minSupport?: number;
  /** The bootstrap resample count. Defaults to {@link SCORECARD_DEFAULT_RESAMPLES}. */
  readonly resamples?: number;
  /**
   * The sha256 of every item, as recomputed from the actual files. When
   * present, an image whose hash diverges from the manifest refuses the
   * scorecard (the runner's integrity gate, reused).
   */
  readonly assetHashes?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** Marks the scorecard as partial: never compared against a baseline (FR-020). */
  readonly partial?: boolean;
  /** Extra limitations to record. */
  readonly extraLimitations?: readonly string[];
  /** Injectable clock, so tests get byte-stable artifacts. */
  readonly now?: Date;
}

// ---------------------------------------------------------------------------
// Partition selection
// ---------------------------------------------------------------------------

/** The result of {@link selectPartition}. */
export interface PartitionSelection {
  /** The partition name that was asked for. */
  readonly name: string;
  /** False when the manifest's partition vocabulary does not carry the name. */
  readonly known: boolean;
  /** The assignments of the partition, sorted by id. Empty when none. */
  readonly assignments: readonly SplitAssignment[];
}

/**
 * Select the assignments of one partition of a split manifest, by name.
 *
 * `known` is false when the name is not one of `train`, `val`, `test` (the
 * manifest's fixed partition vocabulary, `SPLIT_NAMES`): the caller gets a
 * typed `*-partition-missing` refusal, never a silently empty selection.
 */
export function selectPartition(manifest: SplitManifest, name: string): PartitionSelection {
  const known = (SPLIT_NAMES as readonly string[]).includes(name);
  const assignments = manifest.assignments
    .filter((assignment) => assignment.split === name)
    .sort((left, right) => compareIds(left.id, right.id));
  return { name, known, assignments };
}

/** The gold items of a partition, scored under the taxonomy's label keys. */
function partitionGold(assignments: readonly SplitAssignment[]): GoldItem[] {
  return assignments.map((assignment) => ({
    id: assignment.id,
    labelKey: labelKeyOf(assignment),
    split: assignment.split,
  }));
}

/**
 * Restrict a prediction set to the given gold ids.
 *
 * Predictions of OTHER partitions are not part of this measurement and must
 * not inflate the `predictions without gold` count; predictions that match
 * no manifest item at all stay in (they are the orphans, reported, never
 * scored). The surviving order is by id, so downstream digests are stable.
 */
function restrictPredictions(
  predictions: readonly PredictionItem[],
  goldIds: ReadonlySet<string>,
): PredictionItem[] {
  return predictions
    .filter((prediction) => goldIds.has(prediction.id))
    .sort((left, right) => compareIds(left.id, right.id));
}

// ---------------------------------------------------------------------------
// Identity: the derived seed and the content-derived scorecard id
// ---------------------------------------------------------------------------

/** The recorded derivation behind every bootstrap seed (FR-009). */
export const BOOTSTRAP_SEED_DERIVATION =
  'fnv1a32(protocolVersion + "\\u0000" + testSplitFingerprint)';

/**
 * The bootstrap seed: derived from the protocol version and the digest of
 * the evaluated partition, never typed by an operator. The same partition
 * therefore always yields the same interval, and a different partition
 * yields a different one.
 */
export function deriveBootstrapSeed(
  protocolVersion: string,
  testSplitFingerprint: string,
): number {
  return fnv1a32(`${protocolVersion}\u0000${testSplitFingerprint}`);
}

/** The per-partition digest: the shipped partition fingerprint over a subset. */
export function computePartitionDigest(assignments: readonly SplitAssignment[]): string {
  return computePartitionFingerprint(assignments);
}

/**
 * The deterministic id of a scorecard: derived from the content (protocol
 * version, split digests, model version, config fingerprint, prediction
 * digest, calibration partition, bootstrap parameters), never from the
 * clock (FR-018).
 */
export function computeScorecardId(input: {
  readonly protocolVersion: string;
  readonly schemaVersion: number;
  readonly suite: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly configFingerprint: string;
  readonly manifestSha256: string;
  readonly testSplitFingerprint: string;
  readonly calibrationPartition: string;
  readonly calibrationPartitionDigest: string;
  readonly predictionDigest: string;
  readonly probabilitySource: ProbabilitySource;
  readonly minSupport: number;
  readonly bootstrapMethod: BootstrapMethod;
  readonly resamples: number;
  readonly seed: number;
}): string {
  const fingerprint = [
    input.protocolVersion,
    String(input.schemaVersion),
    input.suite,
    input.model,
    input.modelVersion,
    input.configFingerprint,
    input.manifestSha256,
    input.testSplitFingerprint,
    input.calibrationPartition,
    input.calibrationPartitionDigest,
    input.predictionDigest,
    input.probabilitySource,
    String(input.minSupport),
    input.bootstrapMethod,
    String(input.resamples),
    String(input.seed),
  ].join('|');
  return `${input.suite}-${input.model}-sc-${sha256Hex(fingerprint).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// The bootstrap
// ---------------------------------------------------------------------------

/** The intervals of one bootstrap run, keyed the way the scorecard reads them. */
export interface BootstrapIntervals {
  readonly method: BootstrapMethod;
  readonly unit: BootstrapUnit;
  readonly resamples: number;
  readonly seed: number;
  readonly groups?: number;
  readonly macroF1: ScorecardInterval;
  readonly balancedAccuracy: ScorecardInterval;
  readonly perClassF1: ReadonlyMap<string, ScorecardInterval>;
}

/** Build the interval record around already-collected resample values. */
function intervalOf(
  values: readonly number[],
  context: {
    readonly method: BootstrapMethod;
    readonly unit: BootstrapUnit;
    readonly resamples: number;
    readonly seed: number;
    readonly groups?: number;
  },
): ScorecardInterval {
  return {
    lower: percentile(values, SCORECARD_INTERVAL_QUANTILES.lower),
    upper: percentile(values, SCORECARD_INTERVAL_QUANTILES.upper),
    method: context.method,
    resamples: context.resamples,
    seed: context.seed,
    seedDerivation: BOOTSTRAP_SEED_DERIVATION,
    unit: context.unit,
    ...(context.groups === undefined ? {} : { groups: context.groups }),
  };
}

/** Collect the shipped metric values of one resampled multiset. */
function resampleMetrics(
  sampled: readonly ScoredItem[],
  minSupport: number,
  sink: {
    macroF1: number[];
    balancedAccuracy: number[];
    perClassF1: Map<string, number[]>;
  },
): void {
  const perClass = computePerClassMetrics(sampled, minSupport).perClass;
  sink.macroF1.push(computeMacroF1(perClass));
  sink.balancedAccuracy.push(computeBalancedAccuracy(perClass));
  for (const row of perClass) {
    const bucket = sink.perClassF1.get(row.labelKey);
    if (bucket) bucket.push(row.f1);
    else sink.perClassF1.set(row.labelKey, [row.f1]);
  }
}

/**
 * The class-stratified item bootstrap (the default; the only method the
 * tracked split supports).
 *
 * For every resample, each gold class of the evaluated partition contributes
 * exactly as many items as it has, drawn WITH REPLACEMENT inside the class,
 * so the resample's class balance is the original's and the interval
 * describes the sampling noise of the metric, not of the class mix. The
 * metric values come from the SHIPPED per-class functions, unchanged.
 *
 * Determinism: items are ordered by id, classes are visited in label order,
 * and the draws consume one `mulberry32(seed)` stream in that fixed order.
 */
export function stratifiedItemBootstrap(
  items: readonly ScoredItem[],
  options: {
    readonly resamples: number;
    readonly seed: number;
    readonly minSupport: number;
  },
): BootstrapIntervals {
  const byClass = new Map<string, ScoredItem[]>();
  for (const item of items) {
    const bucket = byClass.get(item.goldLabelKey);
    if (bucket) bucket.push(item);
    else byClass.set(item.goldLabelKey, [item]);
  }
  const classOrder = [...byClass.keys()].sort(compareIds);

  const rand = mulberry32(options.seed);
  const sink = { macroF1: [] as number[], balancedAccuracy: [] as number[], perClassF1: new Map<string, number[]>() };

  for (let draw = 0; draw < options.resamples; draw += 1) {
    const sampled: ScoredItem[] = [];
    for (const labelKey of classOrder) {
      const bucket = byClass.get(labelKey) as ScoredItem[];
      for (let index = 0; index < bucket.length; index += 1) {
        sampled.push(bucket[Math.floor(rand() * bucket.length)] as ScoredItem);
      }
    }
    resampleMetrics(sampled, options.minSupport, sink);
  }

  const context = {
    method: 'stratified-item-bootstrap' as const,
    unit: 'item' as const,
    resamples: options.resamples,
    seed: options.seed,
  };
  const perClassF1 = new Map<string, ScorecardInterval>();
  for (const [labelKey, values] of sink.perClassF1) {
    perClassF1.set(labelKey, intervalOf(values, context));
  }
  return {
    ...context,
    macroF1: intervalOf(sink.macroF1, context),
    balancedAccuracy: intervalOf(sink.balancedAccuracy, context),
    perClassF1,
  };
}

/**
 * The group-aware bootstrap: the capture group is the resampling unit.
 *
 * The groups of the evaluated partition are drawn with replacement, and the
 * metric is recomputed over the pooled items, so the items of one
 * acquisition move together. Selected only when the split's `groupBasis`
 * enforces capture groups (FR-009); the group keys come from the caller
 * because a manifest's assignments carry no group field.
 */
export function groupAwareBootstrap(
  items: readonly ScoredItem[],
  groups: ReadonlyMap<string, string>,
  options: {
    readonly resamples: number;
    readonly seed: number;
    readonly minSupport: number;
  },
): BootstrapIntervals {
  const byGroup = new Map<string, ScoredItem[]>();
  for (const item of items) {
    const key = groups.get(item.id) ?? item.id;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(item);
    else byGroup.set(key, [item]);
  }
  const groupOrder = [...byGroup.keys()].sort(compareIds);
  const groupBuckets = groupOrder.map((key) => byGroup.get(key) as ScoredItem[]);

  const rand = mulberry32(options.seed);
  const sink = { macroF1: [] as number[], balancedAccuracy: [] as number[], perClassF1: new Map<string, number[]>() };

  for (let draw = 0; draw < options.resamples; draw += 1) {
    const sampled: ScoredItem[] = [];
    for (let index = 0; index < groupBuckets.length; index += 1) {
      const bucket = groupBuckets[Math.floor(rand() * groupBuckets.length)] as ScoredItem[];
      sampled.push(...bucket);
    }
    resampleMetrics(sampled, options.minSupport, sink);
  }

  const context = {
    method: 'group-aware-bootstrap' as const,
    unit: 'capture-group' as const,
    resamples: options.resamples,
    seed: options.seed,
    groups: groupBuckets.length,
  };
  const perClassF1 = new Map<string, ScorecardInterval>();
  for (const [labelKey, values] of sink.perClassF1) {
    perClassF1.set(labelKey, intervalOf(values, context));
  }
  return {
    ...context,
    macroF1: intervalOf(sink.macroF1, context),
    balancedAccuracy: intervalOf(sink.balancedAccuracy, context),
    perClassF1,
  };
}

/** Convert the caller's capture-group input to a map, whatever form it takes. */
function toGroupMap(
  groups: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> | undefined {
  if (groups === undefined) return undefined;
  if (groups instanceof Map) return groups;
  return new Map(Object.entries(groups));
}

// ---------------------------------------------------------------------------
// Untrusted-input validation
// ---------------------------------------------------------------------------

/**
 * Validate the prediction set (FR-017): every record must carry a non-empty
 * id and label key, and every optional number must be finite (a probability
 * must also lie in [0, 1]). A violation is a typed refusal naming the item,
 * so the shipped metric functions never meet an input they would have to
 * throw on.
 */
function validatePredictions(predictions: readonly PredictionItem[]): ScorecardError | undefined {
  if (!Array.isArray(predictions)) {
    return errorOf('prediction-set-invalid', 'the prediction set is not an array');
  }
  for (const prediction of predictions) {
    const id = typeof prediction.id === 'string' ? prediction.id : '';
    if (id.trim() === '' || typeof prediction.labelKey !== 'string' || prediction.labelKey.trim() === '') {
      return errorOf(
        'prediction-set-invalid',
        `prediction '${id === '' ? '(unnamed)' : id}' is malformed: expected a non-empty id and label key`,
      );
    }
    if (
      prediction.probability !== undefined &&
      (!Number.isFinite(prediction.probability) ||
        prediction.probability < 0 ||
        prediction.probability > 1)
    ) {
      return errorOf(
        'prediction-set-invalid',
        `prediction '${id}' has an invalid probability ${String(prediction.probability)}; ` +
          'expected a finite number in [0, 1]',
      );
    }
    if (prediction.latencyMs !== undefined && !Number.isFinite(prediction.latencyMs)) {
      return errorOf(
        'prediction-set-invalid',
        `prediction '${id}' has a non-finite latency ${String(prediction.latencyMs)}`,
      );
    }
    if (
      prediction.costUsd !== undefined &&
      (!Number.isFinite(prediction.costUsd) || prediction.costUsd < 0)
    ) {
      return errorOf(
        'prediction-set-invalid',
        `prediction '${id}' has an invalid cost ${String(prediction.costUsd)}; ` +
          'expected a finite amount in USD',
      );
    }
  }
  return undefined;
}

/** Validate the manifest's runtime shape before anything touches its content. */
function validateManifestShape(manifest: SplitManifest): ScorecardError | undefined {
  if (
    typeof manifest.id !== 'string' ||
    manifest.id.trim() === '' ||
    !Array.isArray(manifest.assignments) ||
    typeof manifest.manifestHash !== 'string' ||
    manifest.manifestHash.trim() === ''
  ) {
    return errorOf(
      'manifest-digest-mismatch',
      'the split manifest is malformed: expected a non-empty id, an assignments array and a manifest hash',
    );
  }
  return undefined;
}

/**
 * The manifest integrity gate, reused (task 1.7): the manifest's own hash is
 * recomputed from its content, and every asset hash the caller supplied is
 * compared with the manifest's pin. A tampered manifest or a diverging image
 * hash refuses the scorecard before any metric exists.
 */
function checkIntegrity(
  manifest: SplitManifest,
  assetHashes: ReadonlyMap<string, string>,
): { readonly error?: ScorecardError; readonly unverifiedCount: number } {
  let validation;
  try {
    validation = validateSplitManifestHashes(manifest);
  } catch (error) {
    return {
      error: errorOf(
        'manifest-digest-mismatch',
        `split manifest '${String(manifest.id)}' could not be hashed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      unverifiedCount: 0,
    };
  }
  const divergence = validation.divergences[0];
  if (divergence !== undefined) {
    return {
      error: errorOf(
        'manifest-digest-mismatch',
        `split manifest '${manifest.id}' failed its integrity check: ${divergence.message} ` +
          'Refusing to score against a tampered manifest.',
      ),
      unverifiedCount: 0,
    };
  }

  let unverifiedCount = 0;
  for (const assignment of manifest.assignments) {
    const actual = assetHashes.get(assignment.id);
    if (actual === undefined) {
      unverifiedCount += 1;
      continue;
    }
    if (actual !== assignment.sha256) {
      return {
        error: errorOf(
          'manifest-digest-mismatch',
          `image '${assignment.id}' does not match the split manifest: expected sha256 ` +
            `${assignment.sha256}, got ${actual}. Refusing to score an image set whose ` +
            'hashes diverge from the manifest.',
        ),
        unverifiedCount: 0,
      };
    }
  }
  return { unverifiedCount };
}

/**
 * The regime a baseline entry was recorded in. A baseline written by the
 * whole-set runner (every entry today) is a whole-set number; an entry
 * recorded from a scorecard says so through a `regime` field.
 */
export function baselineRegimeOf(entry: BaselineEntry): string {
  const regime = (entry as { readonly regime?: unknown }).regime;
  return typeof regime === 'string' && regime.trim() !== '' ? regime : WHOLE_SET_REGIME;
}

/**
 * Map one baseline entry to the disclosure form the scorecard lists (FR-013).
 * A retired entry is listed with `holdout: false` and its recorded reason;
 * only a test-partition entry is a holdout number. Malformed entries are
 * refused by returning `undefined`: the caller names them in the limitations.
 */
export function toPriorBaselineReference(entry: BaselineEntry): PriorBaselineReference | undefined {
  if (
    typeof entry.suite !== 'string' ||
    entry.suite.trim() === '' ||
    typeof entry.model !== 'string' ||
    entry.model.trim() === '' ||
    typeof entry.macroF1 !== 'number' ||
    !Number.isFinite(entry.macroF1)
  ) {
    return undefined;
  }
  const status = entry.status === 'retired' ? 'retired' : 'active';
  const regime = baselineRegimeOf(entry);
  return {
    suite: entry.suite,
    model: entry.model,
    modelVersion: entry.modelVersion ?? '',
    macroF1: entry.macroF1,
    splitFingerprint: entry.splitFingerprint ?? '',
    status,
    holdout: status === 'retired' ? false : regime === SCORECARD_REGIME,
    regime,
    ...(status === 'retired' && entry.retiredReason !== undefined
      ? { retiredReason: entry.retiredReason }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Build the scorecard of the `test` partition of a split manifest.
 *
 * Pure and synchronous: no filesystem, no clock except the injectable
 * `generatedAt`. Every untrusted input is validated before it is used, and
 * every refusal is typed (FR-017): an empty or missing partition selection,
 * the test partition named as the calibration source, a tampered manifest,
 * a diverging image hash and a malformed prediction set all return
 * `{ ok: false, error }` and emit nothing.
 *
 * The reproduction tuple and the dataset license gate keep their shipped
 * throwing enforcement (see the module docblock): the tuple is validated by
 * the shipped `assertReproductionTuple` and the license by the shipped
 * `assertDatasetLicensed`, exactly like the runner and the fetch paths.
 */
export function buildScorecard(options: BuildScorecardOptions): ScorecardResult {
  // 1. The reproduction tuple first: an unattributed scorecard must not
  //    even look at the data (the runner's own order of operations).
  const tuple = assertReproductionTuple(options.tuple);

  // 2. The manifest: shape, then the integrity gate (the hash the manifest
  //    claims must be the hash its content produces).
  const shapeError = validateManifestShape(options.splitManifest);
  if (shapeError !== undefined) return { ok: false, error: shapeError };
  if (tuple.splitFingerprint !== options.splitManifest.manifestHash) {
    return failure(
      'manifest-digest-mismatch',
      'the reproduction tuple names split fingerprint ' +
        `'${tuple.splitFingerprint}', but the split manifest '${options.splitManifest.id}' ` +
        `hashes to '${options.splitManifest.manifestHash}'. The scorecard is refused: the ` +
        'run cannot be attributed to this split (the tuple carries the manifest hash).',
    );
  }

  // 3. The constitutional license gate: a dataset without a recorded license
  //    is a dataset the platform may not score.
  assertDatasetLicensed(options.datasetEntry);

  // 4. The prediction set.
  const predictionError = validatePredictions(options.predictions);
  if (predictionError !== undefined) return { ok: false, error: predictionError };

  // 5. Caller knobs: an invalid value falls back to the default and is
  //    named in the limitations, never silently kept.
  const limitations: string[] = [];
  const minSupport = positiveIntegerOr(
    options.minSupport,
    SCORECARD_DEFAULT_MIN_SUPPORT,
    limitations,
    'support rule',
  );
  const resamples = positiveIntegerOr(
    options.resamples,
    SCORECARD_DEFAULT_RESAMPLES,
    limitations,
    'bootstrap resample count',
    2,
  );

  // 6. The evaluated partition: `test`, by name, and nothing else.
  const evaluated = selectPartition(options.splitManifest, SCORECARD_EVALUATED_PARTITION);
  if (!evaluated.known) {
    return failure(
      'test-partition-missing',
      `the split manifest '${options.splitManifest.id}' declares no partition named ` +
        `'${evaluated.name}' (its partition vocabulary is train, val, test)`,
    );
  }
  if (evaluated.assignments.length === 0) {
    return failure(
      'test-partition-empty',
      `the '${evaluated.name}' partition of split manifest '${options.splitManifest.id}' is ` +
        `empty: ${options.splitManifest.assignments.length} assignment(s), none in '${evaluated.name}'. ` +
        'A number over no samples is not a result, so no scorecard is emitted.',
    );
  }

  // 7. The calibration partition: never the test partition (FR-007).
  const calibrationName = options.calibrationPartition ?? SCORECARD_DEFAULT_CALIBRATION_PARTITION;
  if (calibrationName === SCORECARD_EVALUATED_PARTITION) {
    return failure(
      'calibration-partition-is-test',
      `the calibration partition may not be the '${SCORECARD_EVALUATED_PARTITION}' partition: ` +
        'the pack forbids using the test partition to calibrate a threshold or choose a ' +
        'checkpoint. Name a different partition as the calibration source.',
    );
  }
  const calibration = selectPartition(options.splitManifest, calibrationName);
  if (!calibration.known) {
    return failure(
      'calibration-partition-empty',
      `the split manifest '${options.splitManifest.id}' declares no partition named ` +
        `'${calibrationName}' (its partition vocabulary is train, val, test)`,
    );
  }
  if (calibration.assignments.length === 0) {
    return failure(
      'calibration-partition-empty',
      `the '${calibrationName}' partition of split manifest '${options.splitManifest.id}' is ` +
        'empty: the expected calibration error cannot be computed over no samples, so no ' +
        'scorecard is emitted.',
    );
  }

  // 8. The integrity gate over the image hashes the caller could supply.
  const assetHashes = toHashMap(options.assetHashes);
  const integrity = checkIntegrity(options.splitManifest, assetHashes);
  if (integrity.error !== undefined) return { ok: false, error: integrity.error };
  if (integrity.unverifiedCount > 0) {
    limitations.push(
      `The image bytes of ${integrity.unverifiedCount} manifest item(s) were NOT verified ` +
        'against the split manifest: no sha256 was supplied for them. The manifest hash ' +
        'itself was verified, but the bytes behind these items were not.',
    );
  }

  // 9. The metric path: the SHIPPED scoreMetrics over the evaluated
  //    partition only. No train or val item is in the gold set, so none can
  //    be scored; the predictions are restricted to the partition for the
  //    same reason.
  const evaluatedGold = partitionGold(evaluated.assignments);
  const evaluatedIds = new Set(evaluatedGold.map((item) => item.id));
  const evaluatedPredictions = restrictPredictions(options.predictions, evaluatedIds);
  const metrics = scoreMetrics(evaluatedGold, evaluatedPredictions, { minSamples: minSupport });
  const scoredItems = joinGoldAndPredictions(evaluatedGold, evaluatedPredictions).items;

  // 10. The calibration path: the SHIPPED computeCalibration over the
  //     calibration partition only. The test partition contributes nothing.
  const calibrationGold = partitionGold(calibration.assignments);
  const calibrationIds = new Set(calibrationGold.map((item) => item.id));
  const calibrationPredictions = restrictPredictions(options.predictions, calibrationIds);
  const calibrationResult = computeCalibration(calibrationGold, calibrationPredictions);

  // 11. Identity: the three digests, the derived seed, the content id.
  const manifestSha256 = options.splitManifest.manifestHash;
  const testSplitFingerprint = computePartitionDigest(evaluated.assignments);
  const calibrationDigest = computePartitionDigest(calibration.assignments);
  const seed = deriveBootstrapSeed(SCORECARD_PROTOCOL_VERSION, testSplitFingerprint);

  // 12. The interval. The method follows the split's groupBasis, never the
  //     caller's preference (FR-009).
  const groupBasis = options.splitManifest.groupBasis;
  const captureGroupsEnforced = groupBasis?.captureGroupsEnforced === true;
  const groupMap = toGroupMap(options.captureGroups);
  const bootstrap: BootstrapIntervals = captureGroupsEnforced && groupMap !== undefined
    ? groupAwareBootstrap(scoredItems, groupMap, { resamples, seed, minSupport })
    : stratifiedItemBootstrap(scoredItems, { resamples, seed, minSupport });
  if (captureGroupsEnforced && groupMap === undefined) {
    limitations.push(
      'The split enforces capture groups but no capture-group map was supplied, so the ' +
        'interval resamples ITEMS and may understate acquisition-level correlation.',
    );
  }

  // 13. The per-class rows, with their intervals and the exploratory label.
  const perClass: ScorecardPerClassRow[] = metrics.perClass.map((row) => ({
    labelKey: row.labelKey,
    support: row.support,
    predicted: row.predicted,
    truePositives: row.truePositives,
    falsePositives: row.falsePositives,
    falseNegatives: row.falseNegatives,
    precision: row.precision,
    recall: row.recall,
    f1: row.f1,
    ci: bootstrap.perClassF1.get(row.labelKey),
    ...(row.support < DEFAULT_MIN_SAMPLES ? { insufficientSupport: true } : {}),
  }));

  // 14. The metric records: every value carries its count and its partition.
  const metricRecords: ScorecardMetric[] = [
    {
      name: 'macroF1',
      value: metrics.macroF1,
      n: metrics.itemsScored,
      partition: evaluated.name,
      ci: bootstrap.macroF1,
      ciMethod: bootstrap.method,
    },
    {
      name: 'balancedAccuracy',
      value: metrics.balancedAccuracy,
      n: metrics.itemsScored,
      partition: evaluated.name,
      ci: bootstrap.balancedAccuracy,
      ciMethod: bootstrap.method,
    },
    {
      name: 'accuracy',
      value: metrics.accuracy,
      n: metrics.itemsScored,
      partition: evaluated.name,
    },
  ];

  // 15. Coverage: what was expected, what was scored, what was missing. A
  //     gold item without a prediction counts as a failure (FR-005).
  const expected = evaluated.assignments.length;
  const missing = countMissing(scoredItems);
  const scored = expected - missing;
  const manifestIds = new Set(options.splitManifest.assignments.map((assignment) => assignment.id));
  const orphanPredictions = options.predictions.filter(
    (prediction) => !manifestIds.has(prediction.id),
  ).length;
  metricRecords.push({
    name: 'coverage',
    value: expected > 0 ? scored / expected : 0,
    n: expected,
    partition: evaluated.name,
  });

  // 16. Cost: measured and estimated are two fields, never one (FR-011).
  const costSummary = computeCostSummary(scoredItems);
  const cost: ScorecardCost = {
    ...(costSummary.itemsWithCost > 0
      ? { measured: { totalUsd: costSummary.totalCostUsd } }
      : {}),
    ...validatedEstimate(options.estimatedCost, limitations),
    currency: 'USD',
    rateAsOf:
      options.estimatedCost !== undefined && isValidEstimate(options.estimatedCost)
        ? options.estimatedCost.rateAsOf
        : 'unknown',
    itemsWithCost: costSummary.itemsWithCost,
    itemsWithoutCost: costSummary.itemsWithoutCost,
    errorLoss: 'not_estimated',
  };

  // 17. Latency: the pinned percentile method, plus the caller's
  //     cold/warm and model-load timings (FR-012).
  const latencySummary = computeLatencySummary(scoredItems);
  const latencyExtras = validatedLatencyExtras(options.latencyExtras, limitations);
  const latency: ScorecardLatency = {
    count: latencySummary.count,
    p50Ms: latencySummary.p50Ms,
    p95Ms: latencySummary.p95Ms,
    ...latencyExtras,
  };

  // 18. Device and model size: unknown means unknown, never inferred (FR-010).
  const device = validatedDevice(options.device, limitations);
  if (device.kind === 'unknown' || device.name === 'unknown') {
    limitations.push(
      'The device the scorecard was produced on is recorded as unknown: the caller could ' +
        'not name it, and a device is never guessed from the platform string.',
    );
  }
  const modelSize =
    options.modelSizeBytes !== undefined &&
    Number.isFinite(options.modelSizeBytes) &&
    options.modelSizeBytes >= 0
      ? options.modelSizeBytes
      : 'unknown';
  if (modelSize === 'unknown') {
    limitations.push(
      'The model size is not recorded anywhere in the repository and was not supplied; it ' +
        "is recorded as 'unknown' rather than estimated.",
    );
  }

  // 19. The prior baselines of the suite's family (FR-013).
  const priorBaselines: PriorBaselineReference[] = [];
  if (options.baselineFile !== undefined) {
    options.baselineFile.entries.forEach((entry, index) => {
      const reference = toPriorBaselineReference(entry);
      if (reference === undefined) {
        limitations.push(
          `Baseline file entry ${index} is malformed and is not listed as a prior baseline.`,
        );
        return;
      }
      priorBaselines.push(reference);
    });
  }

  // 20. The limitations: the shipped caveats folded in, then the
  //     scorecard's own disclosures.
  limitations.unshift(...metrics.caveats);
  if (metrics.unseenPredictedLabels.length > 0) {
    const totalUnseen = metrics.unseenPredictedLabels.reduce((sum, entry) => sum + entry.count, 0);
    limitations.push(
      `${totalUnseen} item(s) were answered with a label outside the gold vocabulary ` +
        `(${metrics.unseenPredictedLabels.map((entry) => `${entry.labelKey} (${entry.count})`).join(', ')}). ` +
        'They are scored as misses: the model did not classify those images.',
    );
  }
  const vocabulary = manifestVocabulary(options.splitManifest);
  const rowByLabel = new Map(perClass.map((row) => [row.labelKey, row]));
  for (const labelKey of vocabulary) {
    if (rowByLabel.has(labelKey)) continue;
    const support = scoredItems.filter((item) => item.goldLabelKey === labelKey).length;
    limitations.push(
      support === 0
        ? `Class '${labelKey}' has no support in the selected partition '${evaluated.name}' ` +
          'and has no per-class row: a missing class can never look like a good one.'
        : `Class '${labelKey}' has support ${support} in partition '${evaluated.name}', below ` +
          `the scorecard support rule of ${minSupport}; it is excluded from the per-class ` +
          'rows and from the macro F1.',
    );
  }
  if (perClass.some((row) => row.insufficientSupport === true)) {
    const exploratory = perClass
      .filter((row) => row.insufficientSupport === true)
      .map((row) => `${row.labelKey} (${row.support})`);
    limitations.push(
      `The class-level results are exploratory: the support of ${exploratory.join(', ')} is ` +
        `below the runner's whole-set default of ${DEFAULT_MIN_SAMPLES}, so the per-class ` +
        'intervals are wide and the rows carry the insufficientSupport flag.',
    );
  }
  if (bootstrap.method === 'stratified-item-bootstrap') {
    if (groupBasis?.statement !== undefined) limitations.push(groupBasis.statement);
    limitations.push(
      `The interval method is '${bootstrap.method}': the partition is item level and cannot ` +
        'prove acquisition-level independence, so the interval describes item-level sampling ' +
        'noise only.',
    );
  }
  const probabilitySource = options.probabilitySource ?? 'raw_declared';
  if (probabilitySource === 'raw_declared') {
    limitations.push(
      'The probability source is raw_declared: the calibration number describes the ' +
        "provider's self-declared confidence, not a calibrated probability (ADR-008).",
    );
  }
  limitations.push(
    'The prediction set is a single run. A stochastic model needs several runs over the ' +
      'same partition, each with its own interval, before its numbers are quoted.',
  );
  if (orphanPredictions > 0) {
    limitations.push(
      `${orphanPredictions} prediction(s) match no gold item of the manifest and are not scored.`,
    );
  }
  if (options.partial === true) {
    limitations.push(
      'This scorecard is PARTIAL: the prediction set was incomplete (e.g. a provider ' +
        'outage). A partial scorecard is never compared against a baseline.',
    );
  }
  limitations.push(...(options.extraLimitations ?? []));

  // 21. The split block and the scorecard id.
  const counts = {
    train: options.splitManifest.assignments.filter((assignment) => assignment.split === 'train')
      .length,
    val: options.splitManifest.assignments.filter((assignment) => assignment.split === 'val')
      .length,
    test: options.splitManifest.assignments.filter((assignment) => assignment.split === 'test')
      .length,
  };
  const scorecardId = computeScorecardId({
    protocolVersion: SCORECARD_PROTOCOL_VERSION,
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    suite: options.suite,
    model: options.model,
    modelVersion: tuple.modelVersion,
    configFingerprint: tuple.configFingerprint,
    manifestSha256,
    testSplitFingerprint,
    calibrationPartition: calibration.name,
    calibrationPartitionDigest: calibrationDigest,
    predictionDigest: computePredictionDigest(options.predictions),
    probabilitySource,
    minSupport,
    bootstrapMethod: bootstrap.method,
    resamples,
    seed,
  });

  const now = options.now ?? new Date();
  const scorecard: Scorecard = {
    protocolVersion: SCORECARD_PROTOCOL_VERSION,
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    scorecardId,
    generatedAt: now.toISOString(),
    partial: options.partial === true,
    suite: options.suite,
    model: options.model,
    modelVersion: tuple.modelVersion,
    configFingerprint: tuple.configFingerprint,
    snapshotId: tuple.snapshotId,
    dataset: {
      id: options.datasetEntry.id,
      version: options.datasetEntry.version,
      license: options.datasetEntry.license,
      licenseUrl: options.datasetEntry.licenseUrl,
      attribution: options.datasetEntry.attribution,
    },
    device,
    modelSize,
    split: {
      manifestId: options.splitManifest.id,
      strategy: options.splitManifest.strategy ?? 'grouped',
      evaluatedPartition: evaluated.name,
      calibrationPartition: calibration.name,
      counts,
      captureGroupsEnforced,
    },
    regime: SCORECARD_REGIME,
    supportRule: minSupport,
    testSplitFingerprint,
    manifestSha256,
    metrics: metricRecords,
    perClass,
    confusion: metrics.confusion,
    calibration: {
      ece: calibrationResult.ece,
      bins: calibrationResult.bins,
      partition: calibration.name,
      n: calibrationResult.itemsScored,
      partitionDigest: calibrationDigest,
      probabilitySource,
      ...(options.calibratorRef !== undefined && options.calibratorRef.trim() !== ''
        ? { calibratorRef: options.calibratorRef }
        : {}),
    },
    cost,
    latency,
    coverage: {
      expected,
      scored,
      missing,
      coverage: expected > 0 ? scored / expected : 0,
      orphanPredictions,
    },
    limitations,
    priorBaselines,
    artifactRefs: [],
    reproduction: tuple,
  };

  return { ok: true, scorecard };
}

/** Count the gold items of the scored set that had no prediction. */
function countMissing(scoredItems: readonly ScoredItem[]): number {
  return scoredItems.filter((item) => item.predictedLabelKey === null).length;
}

/** The label vocabulary of the WHOLE manifest: what a partition could contain. */
function manifestVocabulary(manifest: SplitManifest): string[] {
  return [...new Set(manifest.assignments.map((assignment) => labelKeyOf(assignment)))].sort(
    compareIds,
  );
}

/** A positive integer or the default, with a limitation naming the refusal. */
function positiveIntegerOr(
  value: number | undefined,
  fallback: number,
  limitations: string[],
  what: string,
  minimum = 1,
): number {
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && value >= minimum) return value;
  limitations.push(
    `The supplied ${what} '${String(value)}' is not a valid integer of at least ${minimum}; ` +
      `the default of ${fallback} was used instead.`,
  );
  return fallback;
}

function isValidEstimate(estimate: ScorecardEstimatedCostInput | undefined): boolean {
  return (
    estimate !== undefined &&
    typeof estimate.rateAsOf === 'string' &&
    estimate.rateAsOf.trim() !== '' &&
    Number.isFinite(estimate.totalUsd) &&
    estimate.totalUsd >= 0
  );
}

/** The estimate, when it is honestly formed; otherwise nothing plus a limitation. */
function validatedEstimate(
  estimate: ScorecardEstimatedCostInput | undefined,
  limitations: string[],
): { readonly estimated?: { readonly totalUsd: number; readonly rateAsOf: string; readonly source: string } } {
  if (estimate === undefined) return {};
  if (!isValidEstimate(estimate)) {
    limitations.push(
      'The supplied cost estimate was malformed (a finite non-negative amount and a ' +
        'non-empty rate as-of date are required) and is not recorded.',
    );
    return {};
  }
  return {
    estimated: {
      totalUsd: estimate.totalUsd,
      rateAsOf: estimate.rateAsOf,
      source: SCORECARD_PRICING_SOURCE,
    },
  };
}

/** The latency extras that are finite; the rest are refused with a limitation. */
function validatedLatencyExtras(
  extras: ScorecardLatencyExtrasInput | undefined,
  limitations: string[],
): { readonly coldMs?: number; readonly warmMs?: number; readonly modelLoadMs?: number } {
  if (extras === undefined) return {};
  const pick = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isFinite(value) ? value : undefined;
  const coldMs = pick(extras.coldMs);
  const warmMs = pick(extras.warmMs);
  const modelLoadMs = pick(extras.modelLoadMs);
  if (
    (extras.coldMs !== undefined && coldMs === undefined) ||
    (extras.warmMs !== undefined && warmMs === undefined) ||
    (extras.modelLoadMs !== undefined && modelLoadMs === undefined)
  ) {
    limitations.push(
      'A supplied latency extra (cold, warm or model load) was non-finite and is not recorded.',
    );
  }
  return {
    ...(coldMs === undefined ? {} : { coldMs }),
    ...(warmMs === undefined ? {} : { warmMs }),
    ...(modelLoadMs === undefined ? {} : { modelLoadMs }),
  };
}

/** The device as it can be honestly recorded; an unusable kind becomes unknown. */
function validatedDevice(
  device: ScorecardDeviceInput | undefined,
  limitations: string[],
): ScorecardDevice {
  const kinds: readonly string[] = ['cpu', 'mps', 'cuda', 'unknown'];
  const kind = device?.kind;
  const name = device?.name;
  if (kind !== undefined && !kinds.includes(kind)) {
    limitations.push(
      `The supplied device kind '${String(kind)}' is not one of cpu, mps, cuda, unknown and ` +
        "is recorded as 'unknown'.",
    );
  }
  return {
    kind: kind !== undefined && kinds.includes(kind) ? kind : 'unknown',
    name: typeof name === 'string' && name.trim() !== '' ? name : 'unknown',
    ...(Number.isFinite(device?.memoryGb) ? { memoryGb: device?.memoryGb } : {}),
  };
}

/** Hash-map conversion shared with the runner's asset-hash input shape. */
function toHashMap(
  hashes: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
): Map<string, string> {
  if (hashes === undefined) return new Map();
  if (hashes instanceof Map) return new Map(hashes);
  return new Map(Object.entries(hashes));
}

// ---------------------------------------------------------------------------
// The regime check (FR-014, FR-020)
// ---------------------------------------------------------------------------

/** The verdict of {@link checkScorecardBaseline}. */
export type ScorecardBaselineCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ScorecardError };

/**
 * Refuse a comparison the regimes do not permit, BEFORE any number is
 * compared, naming both sides.
 *
 * A scorecard is a test-partition number; a baseline recorded by the
 * whole-set runner is a whole-set number. The two share a split fingerprint
 * (the same manifest file), so the split-identity checks alone cannot tell
 * them apart: this check compares the REGIMES and refuses the crossing
 * (FR-014). It also refuses a partial scorecard (FR-020), a retired
 * baseline (evidence, never a comparison) and a baseline that belongs to
 * another split (both digests named).
 *
 * This is the check the gate calls before its macro F1 comparison; it lives
 * here so the scorecard owns the vocabulary the gate needs.
 */
export function checkScorecardBaseline(
  scorecard: Scorecard,
  baseline: BaselineEntry,
): ScorecardBaselineCheck {
  if (scorecard.partial) {
    return {
      ok: false,
      error: {
        code: 'baseline-regime-mismatch',
        message:
          `the scorecard '${scorecard.scorecardId}' is partial and is never compared ` +
          'against a baseline: the scoring set was incomplete, so the comparison would ' +
          'measure the outage, not the model.',
      },
    };
  }
  if (baseline.status === 'retired') {
    return {
      ok: false,
      error: {
        code: 'baseline-regime-mismatch',
        message:
          `the baseline of '${baseline.suite}/${baseline.model}' is retired and is evidence, ` +
          'never a comparison: ' +
          `${baseline.retiredReason ?? 'no reason recorded'}`,
      },
    };
  }
  if (
    typeof baseline.splitFingerprint === 'string' &&
    baseline.splitFingerprint !== scorecard.manifestSha256
  ) {
    return {
      ok: false,
      error: {
        code: 'manifest-digest-mismatch',
        message:
          `the baseline of '${baseline.suite}/${baseline.model}' was recorded against the ` +
          `split with manifest hash '${baseline.splitFingerprint}', but the scorecard ` +
          `'${scorecard.scorecardId}' was measured against ` +
          `'${scorecard.manifestSha256}'. The two numbers belong to different splits and ` +
          'are not compared.',
      },
    };
  }
  const baselineRegime = baselineRegimeOf(baseline);
  if (baselineRegime !== scorecard.regime) {
    return {
      ok: false,
      error: {
        code: 'baseline-regime-mismatch',
        message:
          `the scorecard '${scorecard.scorecardId}' is a '${scorecard.regime}' number, but ` +
          `the baseline of '${baseline.suite}/${baseline.model}' is a '${baselineRegime}' ` +
          'number. The two regimes share a split fingerprint but measure different ' +
          'partitions (a test-partition scorecard against a whole-set baseline), so they ' +
          'are not compared.',
      },
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Per-sample rows and the artifacts
// ---------------------------------------------------------------------------

/** One row of the per-sample artifact: one line per scored item. */
export interface ScorecardPerSampleRow {
  readonly id: string;
  readonly goldLabelKey: string;
  /** `null` when the gold item had no prediction (counted as a failure). */
  readonly predictedLabelKey: string | null;
  readonly correct: boolean;
  readonly confidence?: number;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly partition: string;
}

/**
 * The per-sample rows of a partition: one row per scored item, in id order,
 * built through the shipped join so the rows can never disagree with the
 * scorecard's own numbers.
 */
export function buildPerSampleRows(
  splitManifest: SplitManifest,
  predictions: readonly PredictionItem[],
  partition: string = SCORECARD_EVALUATED_PARTITION,
): ScorecardPerSampleRow[] {
  const selection = selectPartition(splitManifest, partition);
  const gold = partitionGold(selection.assignments);
  const goldIds = new Set(gold.map((item) => item.id));
  const joined = joinGoldAndPredictions(gold, restrictPredictions(predictions, goldIds));
  return joined.items.map((item) => ({
    id: item.id,
    goldLabelKey: item.goldLabelKey,
    predictedLabelKey: item.predictedLabelKey,
    correct: item.correct,
    ...(item.probability !== undefined ? { confidence: item.probability } : {}),
    ...(item.latencyMs !== undefined ? { latencyMs: item.latencyMs } : {}),
    ...(item.costUsd !== undefined ? { costUsd: item.costUsd } : {}),
    partition,
  }));
}

/** Byte-stable serialization of the per-sample artifact (JSONL + newline). */
export function serializePerSampleArtifact(rows: readonly ScorecardPerSampleRow[]): string {
  const lines = [JSON.stringify([...PER_SAMPLE_ARTIFACT_COLUMNS])];
  for (const row of rows) lines.push(JSON.stringify(row));
  return `${lines.join('\n')}\n`;
}

/** Byte-stable serialization of the scorecard (2-space JSON + newline). */
export function serializeScorecard(scorecard: Scorecard): string {
  return `${JSON.stringify(scorecard, null, 2)}\n`;
}

/** The committed pointer file: the published claim over gitignored artifacts. */
export interface ScorecardPointer {
  readonly protocolVersion: string;
  readonly scorecardId: string;
  readonly suite: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly configFingerprint: string;
  readonly snapshotId: string;
  readonly regime: string;
  readonly manifestSha256: string;
  readonly testSplitFingerprint: string;
  /** The base the artifact paths are relative to ('.' for the repository root). */
  readonly pathBase: string;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly scorecardSha256: string;
  readonly reproduce: { readonly command: string; readonly note: string };
}

/** Options of {@link writeScorecardArtifacts}. */
export interface WriteScorecardArtifactsOptions {
  readonly scorecard: Scorecard;
  readonly splitManifest: SplitManifest;
  readonly predictions: readonly PredictionItem[];
  /** Where the per-sample artifact and the scorecard land. Gitignored. */
  readonly outputDir?: string;
  /** Where the committed pointer file lands. Tracked. */
  readonly pointerPath?: string;
  /** The base the recorded artifact paths are relative to. Defaults to '.'. */
  readonly pathBase?: string;
  /** The command context that reproduces the artifacts. */
  readonly reproduce?: { readonly command: string; readonly note?: string };
}

/** The outcome of {@link writeScorecardArtifacts}: written paths, or a typed failure. */
export type WriteScorecardArtifactsResult =
  | {
      readonly ok: true;
      readonly perSamplePath: string;
      readonly scorecardPath: string;
      readonly pointerPath: string;
      readonly scorecardWithRefs: Scorecard;
      readonly refs: readonly ArtifactRef[];
      readonly scorecardSha256: string;
      readonly rows: number;
    }
  | { readonly ok: false; readonly error: ScorecardError };

/** Default pointer path of a (suite, model) pair. */
export function defaultScorecardPointerPath(suite: string, model: string): string {
  return path.join(SCORECARD_DEFAULT_POINTER_DIR, `${suite}.${model}.json`);
}

/** Whether a path already exists on disk. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** The bytes of a file, or null when it does not exist. */
async function readIfExists(target: string): Promise<Buffer | null> {
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

/** Put a file back to the bytes a published pointer names. */
async function restoreArtifact(target: string, body: Buffer): Promise<void> {
  const temp = `${target}.tmp`;
  await writeFile(temp, body);
  await rename(temp, target);
}

/**
 * Write the per-sample artifact, the scorecard artifact and the committed
 * pointer, in one operation (FR-015).
 *
 * The per-sample artifact and the scorecard land under the gitignored
 * results directory; the pointer lands where the caller points it (by
 * default the tracked `benchmarks/scorecards/` directory) and records, for
 * each artifact, its relative path, its sha256, its byte count and its row
 * count, plus the scorecard digest. A mismatch found later by
 * {@link verifyScorecardArtifacts} is a failure, never a warning.
 *
 * Every file is staged in a sibling temp file and renamed into place, so a
 * failed write never leaves a half-written artifact nor a half-written tracked
 * pointer behind. When the write fails, the staging files and the run
 * directory this run created are removed, so nothing that could be mistaken
 * for a published claim survives; a run directory that already existed is
 * kept, and the scorecard bytes it held are put back, because a published
 * pointer may still name them.
 */
export async function writeScorecardArtifacts(
  options: WriteScorecardArtifactsOptions,
): Promise<WriteScorecardArtifactsResult> {
  const scorecard = options.scorecard;
  const rows = buildPerSampleRows(
    options.splitManifest,
    options.predictions,
    scorecard.split.evaluatedPartition,
  );
  if (rows.length !== scorecard.coverage.expected) {
    return {
      ok: false,
      error: {
        code: 'artifact-write-failed',
        message:
          `the per-sample rows count ${rows.length} does not match the scorecard's expected ` +
          `count ${scorecard.coverage.expected}: the scorecard and the manifest disagree, ` +
          'so no artifact is written.',
      },
    };
  }

  const outputDir = options.outputDir ?? SCORECARD_DEFAULT_RESULTS_DIR;
  const runDir = path.join(outputDir, scorecard.scorecardId);
  const pathBase = options.pathBase ?? '.';
  const relative = (absolute: string): string =>
    path.relative(pathBase, absolute).split(path.sep).join('/');

  const perSampleBody = serializePerSampleArtifact(rows);
  const perSamplePath = path.join(runDir, 'per-sample.jsonl');
  const perSampleRef: ArtifactRef = {
    role: 'per-sample',
    path: relative(perSamplePath),
    sha256: sha256Hex(perSampleBody),
    bytes: Buffer.byteLength(perSampleBody, 'utf8'),
    rows: rows.length,
    tracked: false,
  };

  const scorecardWithRefs: Scorecard = { ...scorecard, artifactRefs: [perSampleRef] };
  const scorecardBody = serializeScorecard(scorecardWithRefs);
  const scorecardPath = path.join(runDir, 'scorecard.json');
  const scorecardSha256 = sha256Hex(scorecardBody);
  const scorecardRef: ArtifactRef = {
    role: 'scorecard',
    path: relative(scorecardPath),
    sha256: scorecardSha256,
    bytes: Buffer.byteLength(scorecardBody, 'utf8'),
    rows: 1,
    tracked: false,
  };

  const pointerPath =
    options.pointerPath ?? defaultScorecardPointerPath(scorecard.suite, scorecard.model);
  const pointer: ScorecardPointer = {
    protocolVersion: scorecard.protocolVersion,
    scorecardId: scorecard.scorecardId,
    suite: scorecard.suite,
    model: scorecard.model,
    modelVersion: scorecard.modelVersion,
    configFingerprint: scorecard.configFingerprint,
    snapshotId: scorecard.snapshotId,
    regime: scorecard.regime,
    manifestSha256: scorecard.manifestSha256,
    testSplitFingerprint: scorecard.testSplitFingerprint,
    pathBase,
    artifactRefs: [perSampleRef, scorecardRef],
    scorecardSha256,
    reproduce: {
      command: options.reproduce?.command ?? 'unknown',
      note:
        options.reproduce?.note ??
        'the artifacts are gitignored; the digests above are the published claim',
    },
  };

  const pointerTempPath = `${pointerPath}.tmp`;
  const perSampleTempPath = `${perSamplePath}.tmp`;
  const scorecardTempPath = `${scorecardPath}.tmp`;
  // A run directory this run did not create may still hold the artifacts a
  // previously published pointer names; a failed run must not delete them.
  const runDirExisted = await pathExists(runDir);
  // The scorecard artifact carries the clock, so a rerun produces different
  // bytes for it, while a published pointer names the bytes it published. The
  // published bytes are captured before this run replaces them, so a failed
  // run can put them back and the pointer keeps describing what is on disk.
  // The per-sample artifact carries no clock and is byte-stable, so replacing
  // it never invalidates a digest.
  const publishedScorecardBody = runDirExisted ? await readIfExists(scorecardPath) : null;
  let scorecardReplaced = false;
  let restoreFailure: string | undefined;

  try {
    await mkdir(runDir, { recursive: true });
    await mkdir(path.dirname(pointerPath), { recursive: true });
    // Every file is staged in a sibling temp file and renamed, the same rule
    // the rest of the repo follows for JSON artifacts: a failure never leaves
    // a half-written artifact, and never a half-written tracked pointer.
    //
    // The pointer is staged BEFORE the artifacts are renamed into place, so
    // the failure that matters most (the pointer cannot be written) is
    // reached while the artifacts a published pointer names are still
    // untouched.
    await writeFile(pointerTempPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
    await writeFile(perSampleTempPath, perSampleBody, 'utf8');
    await writeFile(scorecardTempPath, scorecardBody, 'utf8');
    await rename(perSampleTempPath, perSamplePath);
    await rename(scorecardTempPath, scorecardPath);
    scorecardReplaced = true;
    await rename(pointerTempPath, pointerPath);
  } catch (error) {
    // A failed run leaves nothing behind that could be mistaken for a claim:
    // the staging files go, and the run directory goes when this run created
    // it. A run directory that already existed is kept, because a published
    // pointer may still name the artifacts it holds.
    await Promise.all([
      rm(perSampleTempPath, { force: true }),
      rm(scorecardTempPath, { force: true }),
      rm(pointerTempPath, { force: true }),
    ]).catch(() => undefined);
    if (!runDirExisted) {
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    } else if (scorecardReplaced && publishedScorecardBody !== null) {
      // The pointer was not renamed, so it still names the published bytes:
      // they go back, and the claim stays true of what is on disk. A restore
      // that fails is named in the message: a swallowed failure would leave a
      // pointer naming bytes that are no longer there, silently.
      try {
        await restoreArtifact(scorecardPath, publishedScorecardBody);
      } catch (restoreError) {
        restoreFailure = `the published scorecard artifact could not be restored: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`;
      }
    }
    return {
      ok: false,
      error: {
        code: 'artifact-write-failed',
        message:
          `writing the scorecard artifacts failed: ${error instanceof Error ? error.message : String(error)}` +
          (restoreFailure === undefined ? '' : `; ${restoreFailure}`),
      },
    };
  }

  return {
    ok: true,
    perSamplePath,
    scorecardPath,
    pointerPath,
    scorecardWithRefs,
    refs: pointer.artifactRefs,
    scorecardSha256,
    rows: rows.length,
  };
}

/** The outcome of {@link verifyScorecardArtifacts}. */
export type ScorecardArtifactVerification =
  | {
      readonly ok: true;
      readonly refs: readonly ArtifactRef[];
      readonly scorecardId: string;
    }
  | { readonly ok: false; readonly error: ScorecardError };

/**
 * Verify a committed pointer against the artifacts it names.
 *
 * Every artifact ref is re-read, its sha256 and byte count are recomputed,
 * the per-sample row count is recounted, and the scorecard artifact must
 * still name the pointer's scorecard id, manifest hash and test digest. Any
 * mismatch is a FAILURE with the path and both values named, never a
 * warning (US5, acceptance scenario 2).
 */
export async function verifyScorecardArtifacts(
  pointerPath: string,
  options: { readonly root?: string } = {},
): Promise<ScorecardArtifactVerification> {
  const fail = (message: string): ScorecardArtifactVerification => ({
    ok: false,
    error: { code: 'artifact-write-failed', message },
  });

  let pointerText: string;
  try {
    pointerText = await readFile(pointerPath, 'utf8');
  } catch (error) {
    return fail(
      `the pointer file '${pointerPath}' cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: ScorecardPointer;
  try {
    parsed = JSON.parse(pointerText) as ScorecardPointer;
  } catch (error) {
    return fail(
      `the pointer file '${pointerPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed.artifactRefs) || parsed.artifactRefs.length === 0) {
    return fail(`the pointer file '${pointerPath}' records no artifact refs`);
  }
  const base = options.root ?? parsed.pathBase ?? '.';

  for (const ref of parsed.artifactRefs) {
    const absolute = path.resolve(base, ref.path);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      return fail(
        `the artifact '${ref.path}' (${ref.role}) named by '${pointerPath}' cannot be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const actualDigest = sha256Hex(bytes);
    if (actualDigest !== ref.sha256) {
      return fail(
        `the artifact '${ref.path}' (${ref.role}) does not match the pointer: expected ` +
          `sha256 ${ref.sha256}, recomputed ${actualDigest}. The published claim and the ` +
          'artifact disagree.',
      );
    }
    if (bytes.byteLength !== ref.bytes) {
      return fail(
        `the artifact '${ref.path}' (${ref.role}) does not match the pointer: expected ` +
          `${ref.bytes} bytes, found ${bytes.byteLength}.`,
      );
    }
    if (ref.role === 'per-sample') {
      const lineCount = bytes.toString('utf8').split('\n').filter((line) => line !== '').length;
      const rowCount = Math.max(lineCount - 1, 0);
      if (rowCount !== ref.rows) {
        return fail(
          `the artifact '${ref.path}' (${ref.role}) does not match the pointer: expected ` +
            `${ref.rows} rows, recounted ${rowCount}.`,
        );
      }
    }
    if (ref.role === 'scorecard') {
      const artifact = JSON.parse(bytes.toString('utf8')) as Scorecard;
      if (artifact.scorecardId !== parsed.scorecardId) {
        return fail(
          `the scorecard artifact '${ref.path}' names id '${artifact.scorecardId}', but the ` +
            `pointer '${pointerPath}' claims '${parsed.scorecardId}'.`,
        );
      }
      if (artifact.manifestSha256 !== parsed.manifestSha256) {
        return fail(
          `the scorecard artifact '${ref.path}' names manifest hash ` +
            `'${artifact.manifestSha256}', but the pointer claims '${parsed.manifestSha256}'.`,
        );
      }
      if (artifact.testSplitFingerprint !== parsed.testSplitFingerprint) {
        return fail(
          `the scorecard artifact '${ref.path}' names test digest ` +
            `'${artifact.testSplitFingerprint}', but the pointer claims ` +
            `'${parsed.testSplitFingerprint}'.`,
        );
      }
    }
  }

  return { ok: true, refs: parsed.artifactRefs, scorecardId: parsed.scorecardId };
}

/**
 * The canonical payload of a scorecard's digests, for readers that want to
 * check the three split identities side by side. They are three different
 * values on the tracked split and are never interchanged.
 */
export function splitIdentitiesOf(scorecard: Scorecard): {
  readonly manifestSha256: string;
  readonly testSplitFingerprint: string;
  readonly regime: string;
} {
  return {
    manifestSha256: scorecard.manifestSha256,
    testSplitFingerprint: scorecard.testSplitFingerprint,
    regime: scorecard.regime,
  };
}
