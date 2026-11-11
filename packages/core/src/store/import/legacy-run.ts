/**
 * The legacy-run importer (spec 002, US2 / task 4).
 *
 * ## What it does
 *
 * Reads a legacy analysis run (`analysis_results.json` and its historical
 * variants) and writes the domain entities into the Master Vision store:
 * `Asset` → `Sample` → `Prediction`, plus the run-level `ExperimentRun`,
 * `OntologyVersion` and `ModelVersion`, plus the human `Annotation`s of the
 * legacy review history and the `CaptureSession`s of the legacy session
 * clusters.
 *
 * ## The constitutional rules it obeys
 *
 *  - **Originals are immutable (II).** The run file and the image bytes are
 *    opened READ-ONLY. Nothing is written next to the run file, nothing is
 *    written into the input or output directory, and the only thing the
 *    importer writes is the target database. (The legacy partial-cache code
 *    DELETES its checkpoint file — that pattern is deliberately NOT copied.)
 *  - **Prediction ≠ Annotation (II).** The model's label becomes a
 *    `Prediction` with a MODEL actor; a human override becomes an
 *    `Annotation` with a HUMAN actor. They never mix.
 *  - **Calibrated uncertainty over declared confidence (V).**
 *    `probabilityRaw` carries the legacy confidence (or `0` when the legacy
 *    file has none — `0` means "unsupported/skipped" in this codebase);
 *    `probabilityCalibrated` stays ABSENT, because no calibration exists.
 *    `latencyMs` and `costMicroUsd` stay ABSENT: they were never recorded,
 *    and a fabricated `0` would look like a measurement.
 *  - **Full-config fingerprints (IV).** The run's `configFingerprint` and the
 *    ontology's `fingerprint` are `fingerprintV2` digests over the REAL
 *    semantic configuration that was imported — including the taxonomy and
 *    the contracts version — never a name-only hash.
 *  - **Evidence over vibes (I).** Everything that could not be recovered
 *    (model, provider, cost, latency, tokens, category descriptions) is
 *    either ABSENT or explicitly marked as unknown. Nothing is invented.
 *  - **Atomicity.** The whole run lands or none of it does. A partial import
 *    of a run is worse than a failed one.
 *
 * ## The mapping
 *
 * | Legacy field | Entity | Caveat |
 * |---|---|---|
 * | `originalFile` / `outputFile` | `Asset` | sha256 of the bytes when reachable, otherwise `unhashed` with a deterministic path-hash placeholder id |
 * | one record per image | `Sample` | one sample per asset |
 * | `category` | `Prediction.labelKey` | the key is the normalized category name |
 * | `confidence` | `Prediction.probabilityRaw` | absent → `0` (never `1`) |
 * | — | `Prediction.probabilityCalibrated` | ABSENT — no calibration exists |
 * | `overrides[]` | `Annotation` | human actor, `cli` surface, history preserved |
 * | `sessions[]` | `CaptureSession` | linked to the assets and samples |
 * | `categories[]` | `OntologyVersion` | NAMES ONLY — descriptions are absent, so they are stored as `''` |
 * | — | `ModelVersion` | placeholder, `registryState: 'legacy'` — the real model is unrecoverable |
 * | the run itself | `ExperimentRun` | `kind: 'classify'`, `status: 'succeeded'` |
 * | `condition` | legacy carry-over | **no domain target** — preserved verbatim, never normalised |
 * | `shortDescription`, `elements`, … | legacy carry-over | preserved verbatim next to the sample |
 *
 * ## Where the legacy carry-over lives
 *
 * `legacy_sample_payloads` is a store-owned table (migration
 * `0002_legacy_import.sql`) that holds the VERBATIM legacy record of every
 * imported sample, plus an explicit `condition_text` column so the legacy
 * `condition` is queryable. It is deliberately OUTSIDE the contracts: the
 * domain model has no field for a free-text condition, and pretending
 * otherwise would put a legacy artifact into the public contract.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CONTRACTS_VERSION, fingerprintV2, type OntologyCategory } from '@master-vision/contracts';
import type { Store } from '../db.js';
import { newEntityId, pathHashPlaceholderId } from '../ids.js';
import { toJsonColumn } from '../json.js';
import { createRepositories } from '../repositories/index.js';
import {
  LegacyImportError,
  basename,
  isPlainObject,
  parseLegacyRun,
  type LegacyImageRecord,
  type LegacyRun,
  type LegacyRunShape,
} from './legacy-shape.js';

/** The placeholder name of a model version whose identity is unrecoverable. */
export const LEGACY_UNKNOWN_MODEL_NAME = 'legacy-unknown';

/** The placeholder version of a model version whose identity is unrecoverable. */
export const LEGACY_UNKNOWN_MODEL_VERSION = 'legacy';

/** The prompt-template marker used by the fingerprint of an imported run. */
export const LEGACY_PROMPT_TEMPLATE = 'legacy-import';

/** The actor recorded for a legacy human override. */
export const LEGACY_REVIEWER_REF = 'user:legacy-cli-reviewer';

/** The display name recorded for a legacy human override. */
export const LEGACY_REVIEWER_NAME = 'Legacy CLI reviewer';

/** What one import maps to, per table. */
export interface LegacyImportCounts {
  /** Assets created (one per imported record). */
  readonly assets: number;
  /** Of those, the ones whose bytes were reachable and hashed. */
  readonly assetsHashed: number;
  /** Of those, the ones whose bytes were unreachable (`unhashed`). */
  readonly assetsUnhashed: number;
  /** Samples (one per asset). */
  readonly samples: number;
  /** Predictions (one per labelled record). */
  readonly predictions: number;
  /** Annotations (the legacy human overrides). */
  readonly annotations: number;
  /** Capture sessions (the legacy session clusters). */
  readonly captureSessions: number;
  /** Ontology versions (0 when the run carried no taxonomy at all). */
  readonly ontologyVersions: number;
  /** Model versions (the placeholder, or the model the run recorded). */
  readonly modelVersions: number;
  /** Experiment runs (the run itself). */
  readonly experimentRuns: number;
  /** Legacy carry-over rows (one per imported record). */
  readonly legacyCarryOvers: number;
  /** Of those, the records that carried a legacy `condition` (no domain target). */
  readonly legacyConditions: number;
  /** Records that carried no file reference at all and were skipped. */
  readonly skippedRecords: number;
  /** Overrides that referenced a file the run does not contain. */
  readonly unmatchedOverrides: number;
}

/** The outcome of an import. */
export interface LegacyImportResult {
  /** The content-addressed id of the run (the idempotency key). */
  readonly manifestId: string;
  /** The detected shape of the run file. */
  readonly shape: LegacyRunShape;
  /** The absolute path of the run file. */
  readonly runPath: string;
  /** The mapping counts. */
  readonly counts: LegacyImportCounts;
  /** True when the run was already in the store (nothing was written). */
  readonly alreadyImported: boolean;
  /** True when rows were written. */
  readonly wrote: boolean;
  /** True when the import was a dry run (nothing was written). */
  readonly dryRun: boolean;
}

/** Options accepted by {@link importLegacyRun}. */
export interface ImportLegacyRunOptions {
  /** Path of the legacy run file. */
  readonly runPath: string;
  /** The target store. Required unless `dryRun` is set. */
  readonly store?: Store;
  /** Root the ORIGINAL images live under. Defaults to a sibling of the run file. */
  readonly inputRoot?: string;
  /** Root the EXPORTED images live under. Defaults to a sibling of the run file. */
  readonly outputRoot?: string;
  /** Compute the mapping and write nothing. */
  readonly dryRun?: boolean;
}

/** The roots the importer reads image bytes from. */
export interface LegacyRoots {
  readonly inputRoot: string;
  readonly outputRoot: string;
}

/**
 * The default roots for a run file.
 *
 * The canonical layout of the pipeline is `<root>/input` and `<root>/output`,
 * with the run file inside `<root>/output`. When the run file sits in a
 * directory named `output`, that layout is assumed; otherwise the roots are
 * the `input` and `output` subdirectories of the run file's own directory.
 */
export function defaultLegacyRoots(runPath: string): LegacyRoots {
  const absolute = path.resolve(runPath);
  const dir = path.dirname(absolute);
  if (path.basename(dir).toLowerCase() === 'output') {
    const root = path.dirname(dir);
    return { inputRoot: path.join(root, 'input'), outputRoot: dir };
  }
  return { inputRoot: path.join(dir, 'input'), outputRoot: path.join(dir, 'output') };
}

/** The plan of an import: what WOULD be written. */
export interface LegacyImportPlan {
  readonly run: LegacyRun;
  readonly runPath: string;
  readonly roots: LegacyRoots;
  readonly categories: readonly OntologyCategory[];
  readonly ontologyFingerprint: string;
  readonly configFingerprint: string;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly startedAt: string;
  readonly counts: LegacyImportCounts;
  /** The resolved asset of every record, in run order (`undefined` when skipped). */
  readonly assets: readonly (PlannedAsset | undefined)[];
  /** The records that were skipped (no file reference at all). */
  readonly skipped: readonly number[];
}

/** A resolved asset of one legacy record. */
export interface PlannedAsset {
  /** The absolute path the bytes were (or would have been) read from. */
  readonly path: string;
  /** The sha256 of the bytes, when they were reachable. */
  readonly sha256?: string;
  /** The size of the bytes, when they were reachable. */
  readonly bytes?: number;
  /** True when the bytes were unreachable. */
  readonly unhashed: boolean;
}

/**
 * Imports a legacy run into the store.
 *
 * The whole import is ONE transaction: either every row lands, or none does.
 * Importing the same run twice is a no-op — the run's manifest id is the
 * idempotency key (SC-002).
 */
export async function importLegacyRun(options: ImportLegacyRunOptions): Promise<LegacyImportResult> {
  const plan = planLegacyRunImport(options);

  if (options.dryRun) {
    return {
      manifestId: plan.run.manifestId,
      shape: plan.run.shape,
      runPath: plan.runPath,
      counts: plan.counts,
      alreadyImported: false,
      wrote: false,
      dryRun: true,
    };
  }

  const store = options.store;
  if (!store) {
    throw new LegacyImportError(
      'importLegacyRun needs a target store: pass `store` (or set `dryRun` to preview the mapping).',
    );
  }

  const write = store.db.transaction(() => writeLegacyRun(store, plan));
  const result = write.immediate();

  return {
    manifestId: plan.run.manifestId,
    shape: plan.run.shape,
    runPath: plan.runPath,
    counts: result.counts,
    alreadyImported: result.alreadyImported,
    wrote: result.wrote,
    dryRun: false,
  };
}

/**
 * Computes what an import WOULD write, without writing anything.
 *
 * The counts it returns are the counts the real import reports — a dry run is
 * a preview, not an estimate.
 */
export function planLegacyRunImport(options: ImportLegacyRunOptions): LegacyImportPlan {
  const runPath = path.resolve(options.runPath);
  const parsed = readLegacyRunFile(runPath);
  const run = parseLegacyRun(parsed);
  const roots = resolveRoots(options, runPath);

  const categories = buildCategories(run);
  const ontologyFingerprint = fingerprintV2({
    model: LEGACY_UNKNOWN_MODEL_NAME,
    promptTemplate: LEGACY_PROMPT_TEMPLATE,
    taxonomy: taxonomyOf(categories),
    preprocessing: {},
    dataVersion: 'legacy-taxonomy',
    contractsVersion: CONTRACTS_VERSION,
  });
  const configFingerprint = fingerprintV2({
    model: LEGACY_UNKNOWN_MODEL_NAME,
    promptTemplate: LEGACY_PROMPT_TEMPLATE,
    taxonomy: taxonomyOf(categories),
    preprocessing: {},
    dataVersion: run.manifestId,
    contractsVersion: CONTRACTS_VERSION,
  });

  // The assets are aligned with the records: a record without any file
  // reference has no asset (`undefined` at its position).
  const assets: (PlannedAsset | undefined)[] = [];
  const skipped: number[] = [];
  let hashed = 0;
  let unhashed = 0;
  let predictions = 0;
  let resolved = 0;
  let conditions = 0;

  run.images.forEach((image, index) => {
    const asset = resolveAsset(image, roots);
    if (!asset) {
      skipped.push(index);
      assets.push(undefined);
      return;
    }
    assets.push(asset);
    resolved += 1;
    if (image.condition !== undefined) conditions += 1;
    if (asset.unhashed) unhashed += 1;
    else hashed += 1;
    if (image.category !== undefined) predictions += 1;
  });

  const startedAt = resolveStartedAt(run);
  // An override needs a file the run contains AND a category to override TO.
  // Without a taxonomy there is nothing to point the annotation at, so no
  // annotation is created — the dry-run count says so too.
  const annotations = categories.length > 0 ? countApplicableOverrides(run) : 0;

  const counts: LegacyImportCounts = {
    assets: resolved,
    assetsHashed: hashed,
    assetsUnhashed: unhashed,
    samples: resolved,
    predictions,
    annotations,
    captureSessions: run.sessions.length,
    ontologyVersions: categories.length > 0 ? 1 : 0,
    modelVersions: 1,
    experimentRuns: 1,
    legacyCarryOvers: resolved,
    legacyConditions: conditions,
    skippedRecords: skipped.length,
    unmatchedOverrides: run.overrides.length - annotations,
  };

  return {
    run,
    runPath,
    roots,
    categories,
    ontologyFingerprint,
    configFingerprint,
    modelName: run.model ?? run.provider ?? LEGACY_UNKNOWN_MODEL_NAME,
    modelVersion: LEGACY_UNKNOWN_MODEL_VERSION,
    startedAt,
    counts,
    assets,
    skipped,
  };
}

/** Reads and parses the run file. Never writes, never deletes. */
function readLegacyRunFile(runPath: string): unknown {
  let text: string;
  try {
    text = readFileSync(runPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new LegacyImportError(`Legacy run file not found: ${runPath}`, { cause: error });
    }
    if (code === 'EISDIR') {
      throw new LegacyImportError(`Legacy run path is a directory, not a file: ${runPath}`, {
        cause: error,
      });
    }
    throw new LegacyImportError(
      `Cannot read the legacy run file '${runPath}': ${(error as Error).message}`,
      { cause: error },
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new LegacyImportError(
      `The legacy run file '${runPath}' is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/** Resolves the roots the importer reads bytes from. */
function resolveRoots(options: ImportLegacyRunOptions, runPath: string): LegacyRoots {
  const defaults = defaultLegacyRoots(runPath);
  return {
    inputRoot: path.resolve(options.inputRoot ?? defaults.inputRoot),
    outputRoot: path.resolve(options.outputRoot ?? defaults.outputRoot),
  };
}

/**
 * The taxonomy of the imported run.
 *
 * The legacy file records category NAMES ONLY — there are no descriptions.
 * A missing description is therefore stored as the EMPTY STRING, which the
 * contract allows (`description: z.string()`) and which means "not
 * recorded". No description is invented, and the fingerprint of the ontology
 * therefore hashes the taxonomy that actually existed: names with no
 * descriptions.
 */
function buildCategories(run: LegacyRun): OntologyCategory[] {
  const categories: OntologyCategory[] = [];
  const seenKeys = new Set<string>();
  for (const name of run.categoryNames) {
    const key = legacyLabelKey(name);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    categories.push({ key, name, description: '' });
  }
  return categories;
}

/** The taxonomy in the shape `fingerprintV2` expects. */
function taxonomyOf(categories: readonly OntologyCategory[]): Record<string, unknown>[] {
  return categories.map((category) => ({
    key: category.key,
    name: category.name,
    description: category.description,
  }));
}

/**
 * The machine key of a legacy category name.
 *
 * The legacy labels are snake_case (`living_room`); the key keeps that shape
 * so the label of a legacy prediction reads exactly like the label the
 * pipeline produced.
 */
export function legacyLabelKey(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key.length > 0 ? key : 'unknown';
}

/**
 * Resolves the bytes of one legacy record.
 *
 * The resolution order is fixed and documented:
 *
 *   1. `<inputRoot>/<originalFile>` — the ORIGINAL, which is the canonical
 *      source (the exported JPEG has a timestamp burned into it, so hashing
 *      both would produce two different content addresses for one image).
 *   2. `<outputRoot>/<outputFile>` — the export, when the original is gone.
 *   3. `<outputRoot>/<originalFile>` — the original, when it was exported in
 *      place.
 *   4. nothing → the asset is `unhashed` and carries a deterministic
 *      path-hash placeholder id.
 *
 * The importer NEVER fails on missing bytes (spec 002, edge case).
 */
function resolveAsset(image: LegacyImageRecord, roots: LegacyRoots): PlannedAsset | undefined {
  const candidates: string[] = [];
  const inputPath = image.fileName ? resolveWithinRoot(roots.inputRoot, image.fileName) : undefined;
  const outputPath = image.outputFileName
    ? resolveWithinRoot(roots.outputRoot, image.outputFileName)
    : undefined;
  const outputOriginal = image.fileName
    ? resolveWithinRoot(roots.outputRoot, image.fileName)
    : undefined;

  if (inputPath) candidates.push(inputPath);
  if (outputPath) candidates.push(outputPath);
  if (outputOriginal) candidates.push(outputOriginal);

  for (const candidate of candidates) {
    const hashed = hashFile(candidate);
    if (hashed) return hashed;
  }

  // No bytes anywhere: the asset is flagged `unhashed` and keeps the path it
  // was derived from, so spec 004 can re-hash it later.
  const fallback = candidates[0];
  if (!fallback) return undefined;
  return { path: fallback, unhashed: true };
}

/**
 * Joins a file name onto a root, refusing anything that leaves the root.
 *
 * The legacy record stores a BARE name; a hand-edited file could contain a
 * path. Only the last segment is used, and the result is verified to stay
 * inside the root — the importer never follows a path out of the roots it was
 * given.
 */
function resolveWithinRoot(root: string, name: string): string | undefined {
  const leaf = basename(name);
  if (leaf.length === 0 || leaf === '.' || leaf === '..') return undefined;
  const rootAbsolute = path.resolve(root);
  const candidate = path.resolve(rootAbsolute, leaf);
  if (candidate !== rootAbsolute && !candidate.startsWith(rootAbsolute + path.sep)) {
    return undefined;
  }
  return candidate;
}

/** Hashes a file's bytes, or returns `undefined` when it is not readable. */
function hashFile(filePath: string): PlannedAsset | undefined {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return undefined;
    const bytes = readFileSync(filePath);
    return {
      path: filePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: stats.size,
      unhashed: false,
    };
  } catch {
    return undefined;
  }
}

/**
 * The timestamp the run started at.
 *
 * The legacy `processedDate` is preferred; otherwise the earliest image
 * timestamp; otherwise the import time.
 */
function resolveStartedAt(run: LegacyRun): string {
  if (run.processedDate) {
    const parsed = Date.parse(run.processedDate);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  const timestamps = run.images
    .map((image) => image.timestampMs)
    .filter((value): value is number => value !== undefined);
  if (timestamps.length > 0) {
    return new Date(Math.min(...timestamps.map((value) => Math.trunc(value)))).toISOString();
  }
  return new Date().toISOString();
}

/** The ISO timestamp of one record, truncated to whole milliseconds. */
function recordTimestamp(image: LegacyImageRecord, fallback: string): string {
  if (image.timestampMs === undefined) return fallback;
  const truncated = Math.trunc(image.timestampMs);
  if (!Number.isFinite(truncated)) return fallback;
  return new Date(truncated).toISOString();
}

/** Counts the overrides that reference a file the run contains. */
function countApplicableOverrides(run: LegacyRun): number {
  const files = new Set<string>();
  for (const image of run.images) {
    if (image.fileName) files.add(image.fileName);
    if (image.outputFileName) files.add(image.outputFileName);
  }
  let applicable = 0;
  for (const override of run.overrides) {
    if (!override.file || !override.overriddenCategory) continue;
    if (files.has(override.file)) applicable += 1;
  }
  return applicable;
}

/** The outcome of the write phase. */
interface WriteOutcome {
  readonly counts: LegacyImportCounts;
  readonly alreadyImported: boolean;
  readonly wrote: boolean;
}

/**
 * Writes the run. Runs INSIDE the caller's transaction.
 *
 * The manifest check is the first thing that happens: a run that is already
 * in the store produces ZERO new rows.
 */
function writeLegacyRun(store: Store, plan: LegacyImportPlan): WriteOutcome {
  const db = store.db;
  const repos = createRepositories(db);

  const existing = db
    .prepare('SELECT counts_json FROM legacy_imports WHERE manifest_id = ?')
    .get(plan.run.manifestId) as { counts_json: string } | undefined;
  if (existing) {
    return {
      counts: JSON.parse(existing.counts_json) as LegacyImportCounts,
      alreadyImported: true,
      wrote: false,
    };
  }

  // 1. The run itself.
  const experiment = repos.experiments.insert({
    id: newEntityId(),
    kind: 'classify',
    configFingerprint: plan.configFingerprint,
    status: 'succeeded',
    metricsSummaryJson: {
      legacyImport: {
        manifestId: plan.run.manifestId,
        shape: plan.run.shape,
        images: plan.counts.assets,
        categories: plan.categories.length,
        processedDate: plan.run.processedDate ?? null,
      },
    },
    startedAt: plan.startedAt,
    endedAt: plan.startedAt,
  });

  // 2. The model version: the placeholder, unless the run recorded one.
  const existingModel = repos.models.findByNameAndVersion(plan.modelName, plan.modelVersion);
  const model =
    existingModel ??
    repos.models.insert(
      {
        id: newEntityId(),
        name: plan.modelName,
        version: plan.modelVersion,
        registryState: 'legacy',
        recipe: {
          source: 'legacy-run-import',
          manifestId: plan.run.manifestId,
          unrecoverable: [
            'model',
            'provider',
            'categoriesHash',
            'cost',
            'latency',
            'tokens',
            'categoryDescriptions',
          ],
        },
        createdAt: plan.startedAt,
      },
      { experimentRunId: experiment.id },
    );

  // 3. The taxonomy: only when the run actually used one.
  let ontologyId: string | undefined;
  if (plan.categories.length > 0) {
    const existingOntology = repos.ontology.findByFingerprint(plan.ontologyFingerprint);
    const ontology =
      existingOntology ??
      repos.ontology.insert({
        id: newEntityId(),
        version: 'legacy-1',
        categories: [...plan.categories],
        fingerprint: plan.ontologyFingerprint,
        createdAt: plan.startedAt,
      });
    ontologyId = ontology.id;
  }

  // 4. The capture sessions of the legacy session clusters.
  const sessionIds = new Map<number, string>();
  for (const session of plan.run.sessions) {
    const created = repos.captureSessions.insert({
      id: newEntityId(),
      startedAt: sessionTimestamp(session.startMs, plan.startedAt),
      endedAt: session.endMs === undefined ? undefined : sessionTimestamp(session.endMs, plan.startedAt),
      source: `legacy-session-${session.sessionId}`,
      contextJson: {
        legacySessionId: session.sessionId,
        imageNumbers: [...session.imageNumbers],
      },
    });
    sessionIds.set(session.sessionId, created.id);
  }

  // 5. The manifest row: it is the parent of the carry-over rows, so it is
  //    written BEFORE them (foreign keys are checked immediately).
  db.prepare(
    `INSERT INTO legacy_imports (
       manifest_id, run_path, shape, experiment_run_id, ontology_version_id,
       model_version_id, counts_json, imported_at
     ) VALUES (
       @manifest_id, @run_path, @shape, @experiment_run_id, @ontology_version_id,
       @model_version_id, @counts_json, @imported_at
     )`,
  ).run({
    manifest_id: plan.run.manifestId,
    run_path: plan.runPath,
    shape: plan.run.shape,
    experiment_run_id: experiment.id,
    ontology_version_id: ontologyId ?? null,
    model_version_id: model.id,
    counts_json: toJsonColumn(plan.counts),
    imported_at: plan.startedAt,
  });

  // 6. The assets, samples, predictions and the legacy carry-over.
  const sampleByFile = new Map<string, string>();
  const sessionByFile = new Map<string, string>();

  plan.run.images.forEach((image, index) => {
    const planned = plan.assets[index];
    if (!planned) return; // a record without any file reference is skipped

    const createdAt = recordTimestamp(image, plan.startedAt);
    const sessionId = image.sessionId === undefined ? undefined : sessionIds.get(image.sessionId);

    // The asset: content-addressed when the bytes were reachable, and a
    // deterministic path-hash placeholder when they were not.
    const existingAsset = planned.unhashed
      ? repos.assets.getById(pathHashPlaceholderId(planned.path))
      : planned.sha256
        ? repos.assets.findBySha256(planned.sha256)
        : undefined;
    const asset =
      existingAsset ??
      repos.assets.insert({
        id: planned.unhashed ? pathHashPlaceholderId(planned.path) : newEntityId(),
        sha256: planned.unhashed ? undefined : planned.sha256,
        kind: 'image',
        bytes: planned.bytes,
        unhashed: planned.unhashed,
        path: planned.path,
        captureSessionId: sessionId,
        createdAt,
      });

    // The sample: one per asset (the unit of observation of that file).
    const existingSamples = repos.samples.listByAsset(asset.id);
    const sample =
      existingSamples[0] ??
      repos.samples.insert({
        id: newEntityId(),
        assetId: asset.id,
        split: 'unassigned',
        sourceCaptureFrame: image.sessionId === undefined ? undefined : String(image.sessionId),
        snapshotIds: [],
        createdAt,
      });

    if (image.fileName) {
      sampleByFile.set(image.fileName, sample.id);
      if (sessionId) sessionByFile.set(image.fileName, sessionId);
    }
    if (image.outputFileName) {
      sampleByFile.set(image.outputFileName, sample.id);
      if (sessionId) sessionByFile.set(image.outputFileName, sessionId);
    }

    // The prediction: the model's label. Never a calibrated probability.
    if (image.category !== undefined) {
      repos.predictions.insert({
        id: newEntityId(),
        sampleId: sample.id,
        modelVersionId: model.id,
        labelKey: legacyLabelKey(image.category),
        // `confidence ?? 0`: the legacy run recorded no confidence for this
        // image, and 0 means "unsupported/skipped" in this codebase.
        probabilityRaw: image.confidence ?? 0,
        actor: { kind: 'model', ref: `model:${model.id}`, version: model.version },
        surface: 'cli',
        createdAt,
      });
    }

    // The legacy carry-over: the record VERBATIM, plus the explicit
    // `condition` column (the one legacy field with no domain target).
    db.prepare(
      `INSERT INTO legacy_sample_payloads (
         sample_id, manifest_id, condition_text, payload_json
       ) VALUES (
         @sample_id, @manifest_id, @condition_text, @payload_json
       )`,
    ).run({
      sample_id: sample.id,
      manifest_id: plan.run.manifestId,
      condition_text: image.condition ?? null,
      payload_json: toJsonColumn(rawRecordOf(plan.run, image)),
    });
  });

  // 7. The human overrides: an Annotation with a HUMAN actor (II).
  let annotations = 0;
  for (const override of plan.run.overrides) {
    if (!override.file || !override.overriddenCategory) continue;
    const sampleId = sampleByFile.get(override.file);
    if (!sampleId) continue;
    if (!ontologyId) continue;
    const image = plan.run.images.find(
      (candidate) =>
        candidate.fileName === override.file || candidate.outputFileName === override.file,
    );
    repos.annotations.insert({
      id: newEntityId(),
      sampleId,
      ontologyVersionId: ontologyId,
      labelKey: legacyLabelKey(override.overriddenCategory),
      actor: {
        kind: 'human',
        ref: LEGACY_REVIEWER_REF,
        displayName: LEGACY_REVIEWER_NAME,
      },
      surface: 'cli',
      sessionId: sessionByFile.get(override.file),
      createdAt: image ? recordTimestamp(image, plan.startedAt) : plan.startedAt,
    });
    annotations += 1;
  }

  const counts: LegacyImportCounts = {
    ...plan.counts,
    annotations,
    unmatchedOverrides: plan.run.overrides.length - annotations,
  };

  // The counts are stored with the manifest, so a re-import reports exactly
  // what the first import wrote.
  db.prepare('UPDATE legacy_imports SET counts_json = @counts_json WHERE manifest_id = @manifest_id').run({
    counts_json: toJsonColumn(counts),
    manifest_id: plan.run.manifestId,
  });

  return { counts, alreadyImported: false, wrote: true };
}

/** The ISO timestamp of a legacy millisecond value. */
function sessionTimestamp(ms: number | undefined, fallback: string): string {
  if (ms === undefined || !Number.isFinite(ms)) return fallback;
  return new Date(Math.trunc(ms)).toISOString();
}

/**
 * The VERBATIM legacy record of an image, for the carry-over.
 *
 * The normalized record is used when the raw entry cannot be located (the
 * docs-only shapes), so the carry-over is never empty.
 */
function rawRecordOf(run: LegacyRun, image: LegacyImageRecord): unknown {
  const rawImages = isPlainObject(run.raw)
    ? ((run.raw['images'] ?? run.raw['results'] ?? run.raw['processedFiles']) as unknown)
    : undefined;
  if (Array.isArray(rawImages)) {
    const match = rawImages.find(
      (entry) =>
        isPlainObject(entry) &&
        (entry['originalFile'] === image.fileName || entry['file'] === image.fileName),
    );
    if (match !== undefined) return match;
  }
  return { ...image, elements: [...image.elements] };
}
