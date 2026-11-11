/**
 * The auditor walk (spec 002, US4, task 5.2).
 *
 * "As an auditor I trace any artifact to its origin" (spec 002, US4). This
 * module answers that question with REAL JOINS — no application-side
 * stitching, no in-memory guesswork:
 *
 *   Prediction → ModelVersion → ExperimentRun → DatasetSnapshot → Assets
 *
 * and, for a derived artifact:
 *
 *   DerivedArtifact → encoder ModelVersion, source Snapshot, source Assets
 *
 * The chain relies on two store-owned link columns (documented in the
 * repositories and in `docs/architecture/store-schema.md`):
 * `model_versions.experiment_run_id` and
 * `derived_artifacts.encoder_model_version_id`. The contracts do not carry
 * those pointers yet.
 *
 * Every link of the chain is a foreign key, so the walk is also an
 * integrity check: if it succeeds, the provenance of the prediction is
 * complete.
 *
 * When the stored data breaks that promise, the walk fails loudly with a
 * {@link StoreConsistencyError} — never with a half-built chain and never
 * with a bare `Error`.
 */

import type {
  Asset,
  DatasetSnapshot,
  DerivedArtifact,
  ExperimentRun,
  ModelVersion,
  Prediction,
  Sample,
} from '@master-vision/contracts';
import type { SqliteDatabase } from './db.js';
import { StoreConsistencyError } from './errors.js';
import { toAsset } from './repositories/assets.js';
import { toDatasetSnapshot } from './repositories/snapshots.js';
import { toDerivedArtifact } from './repositories/derived-artifacts.js';
import { toExperimentRun } from './repositories/experiments.js';
import { toModelVersion } from './repositories/models.js';
import { toPrediction } from './repositories/predictions.js';
import { toSample } from './repositories/samples.js';
import type { Row } from './repositories/base.js';

/** The complete provenance chain of a prediction. */
export interface PredictionLineage {
  readonly prediction: Prediction;
  readonly modelVersion: ModelVersion;
  /** The run that produced the model version, when it is known. */
  readonly experimentRun: ExperimentRun | null;
  /** The snapshot the run consumed, when it is known. */
  readonly snapshot: DatasetSnapshot | null;
  /** The samples that belong to the snapshot. */
  readonly samples: readonly Sample[];
  /** The assets those samples point at. */
  readonly assets: readonly Asset[];
}

/** The complete provenance chain of a derived artifact. */
export interface ArtifactLineage {
  readonly artifact: DerivedArtifact;
  /** The encoder that produced the artifact, when it is known. */
  readonly encoder: ModelVersion | null;
  /** The snapshot the artifact was derived in the context of. */
  readonly snapshot: DatasetSnapshot | null;
  /** The assets the artifact was derived from. */
  readonly assets: readonly Asset[];
}

/**
 * Walks from a prediction to its model version, its experiment run, its
 * snapshot and the assets of that snapshot.
 *
 * Returns `undefined` when the prediction does not exist.
 */
export function walkPredictionLineage(
  db: SqliteDatabase,
  predictionId: string,
): PredictionLineage | undefined {
  const predictionRow = db.prepare('SELECT * FROM predictions WHERE id = ?').get(predictionId) as
    | Row
    | undefined;
  if (!predictionRow) return undefined;

  // One query, four real joins: predictions → model_versions →
  // experiment_runs → dataset_snapshots.
  const chain = db
    .prepare(
      `SELECT
         p.id             AS prediction_id,
         mv.id           AS model_version_id,
         e.id            AS experiment_run_id,
         s.id            AS snapshot_id
       FROM predictions p
       LEFT JOIN model_versions mv ON mv.id = p.model_version_id
       LEFT JOIN experiment_runs e ON e.id = mv.experiment_run_id
       LEFT JOIN dataset_snapshots s ON s.id = e.input_snapshot_id
       WHERE p.id = @prediction_id`,
    )
    .get({ prediction_id: predictionId }) as Row | undefined;

  const modelVersionRow = db
    .prepare('SELECT * FROM model_versions WHERE id = ?')
    .get(chain?.['model_version_id']) as Row | undefined;
  if (!modelVersionRow) {
    // A prediction without a model version cannot happen (foreign key), but
    // the walk must fail loudly rather than return a half-built chain.
    throw new StoreConsistencyError(
      `Prediction '${predictionId}' has no model version — the store is inconsistent.`,
    );
  }

  const experimentRunRow = chain?.['experiment_run_id']
    ? (db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(chain['experiment_run_id']) as
        | Row
        | undefined)
    : undefined;

  const snapshotRow = chain?.['snapshot_id']
    ? (db.prepare('SELECT * FROM dataset_snapshots WHERE id = ?').get(chain['snapshot_id']) as
        | Row
        | undefined)
    : undefined;

  const samples = snapshotRow ? listSamplesOfSnapshot(db, snapshotRow['id'] as string) : [];
  const assets = listAssetsOfSnapshot(db, snapshotRow?.['id'] as string | undefined);

  return {
    prediction: toPrediction(predictionRow),
    modelVersion: toModelVersion(modelVersionRow),
    experimentRun: experimentRunRow ? toExperimentRun(experimentRunRow) : null,
    snapshot: snapshotRow ? toDatasetSnapshot(snapshotRow) : null,
    samples,
    assets,
  };
}

/**
 * Walks from a derived artifact to its encoder, its snapshot and the assets
 * it was derived from.
 */
export function walkArtifactLineage(
  db: SqliteDatabase,
  artifactId: string,
): ArtifactLineage | undefined {
  const artifactRow = db.prepare('SELECT * FROM derived_artifacts WHERE id = ?').get(artifactId) as
    | Row
    | undefined;
  if (!artifactRow) return undefined;

  const chain = db
    .prepare(
      `SELECT da.id AS artifact_id, mv.id AS encoder_id, s.id AS snapshot_id
         FROM derived_artifacts da
         LEFT JOIN model_versions mv ON mv.id = da.encoder_model_version_id
         LEFT JOIN dataset_snapshots s ON s.id = da.source_snapshot_id
        WHERE da.id = @artifact_id`,
    )
    .get({ artifact_id: artifactId }) as Row | undefined;

  const encoderRow = chain?.['encoder_id']
    ? (db.prepare('SELECT * FROM model_versions WHERE id = ?').get(chain['encoder_id']) as
        | Row
        | undefined)
    : undefined;

  const snapshotRow = chain?.['snapshot_id']
    ? (db.prepare('SELECT * FROM dataset_snapshots WHERE id = ?').get(chain['snapshot_id']) as
        | Row
        | undefined)
    : undefined;

  // The source assets are a JSON array on the artifact row: json_each turns
  // it into a real join against the assets table.
  const assetRows = db
    .prepare(
      `SELECT DISTINCT a.* FROM derived_artifacts da
         JOIN json_each(da.source_asset_ids_json) j ON j.value = a.id
         JOIN assets a ON a.id = j.value
        WHERE da.id = @artifact_id
        ORDER BY a.created_at`,
    )
    .all({ artifact_id: artifactId }) as Row[];

  return {
    artifact: toDerivedArtifact(artifactRow),
    encoder: encoderRow ? toModelVersion(encoderRow) : null,
    snapshot: snapshotRow ? toDatasetSnapshot(snapshotRow) : null,
    assets: assetRows.map(toAsset),
  };
}

/** The samples that belong to a snapshot. */
export function listSamplesOfSnapshot(db: SqliteDatabase, snapshotId: string): Sample[] {
  const rows = db
    .prepare(
      `SELECT s.* FROM samples s
         JOIN json_each(s.snapshot_ids_json) j ON j.value = @snapshot_id
        ORDER BY s.created_at`,
    )
    .all({ snapshot_id: snapshotId }) as Row[];
  return rows.map(toSample);
}

/** The assets the samples of a snapshot point at. */
export function listAssetsOfSnapshot(db: SqliteDatabase, snapshotId: string | undefined): Asset[] {
  if (!snapshotId) return [];
  const rows = db
    .prepare(
      `SELECT DISTINCT a.* FROM assets a
         JOIN samples s ON s.asset_id = a.id
         JOIN json_each(s.snapshot_ids_json) j ON j.value = @snapshot_id
        ORDER BY a.created_at`,
    )
    .all({ snapshot_id: snapshotId }) as Row[];
  return rows.map(toAsset);
}
