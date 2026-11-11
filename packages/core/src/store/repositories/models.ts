/**
 * Model versions: the model registry (spec 002).
 *
 * A prediction points at the exact model version that produced it, so any
 * model output resolves to its artifact, recipe and calibration.
 *
 * ## The `experimentRunId` link
 *
 * The contracts' `ModelVersion` has no pointer to the run that produced it,
 * but the auditor walk (spec 002, task 5.2) must reach the experiment run
 * from a prediction: Prediction → ModelVersion → ExperimentRun → Snapshot →
 * Assets. The store therefore owns ONE extra, nullable, store-level link
 * column (`model_versions.experiment_run_id`). It is not part of the contract
 * entity and never leaks into the returned entity; it is documented as a
 * store-owned link and will be promoted into the contracts when a later spec
 * needs it (which is a `CONTRACTS_VERSION` event).
 *
 * A model version is otherwise immutable — there is no update method.
 */

import { ModelVersionSchema, type ModelVersion } from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { StoreValidationError } from '../errors.js';
import { fromJsonColumn, toJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type JsonValue,
  type Row,
} from './base.js';

/** Store-owned links of a model version (not part of the contract entity). */
export interface ModelVersionLinks {
  /** The run that produced (trained or registered) this model version. */
  readonly experimentRunId?: string;
}

/** The `model_versions` table. */
export class ModelsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts a model version. */
  insert(model: ModelVersion, links: ModelVersionLinks = {}): ModelVersion {
    const entity = parseEntity(ModelVersionSchema, model, 'ModelVersion');

    // The store-owned link is validated BEFORE the write: a typo must produce
    // the store's own actionable error, not a raw `SQLITE_CONSTRAINT_FOREIGNKEY`
    // from the driver.
    if (links.experimentRunId !== undefined) {
      this.assertExperimentRunExists(links.experimentRunId);
    }

    this.db
      .prepare(
        `INSERT INTO model_versions (
           id, name, version, registry_state, recipe_json, artifact_path,
           calibration_ref, model_card_path, experiment_run_id, created_at, updated_at
         ) VALUES (
           @id, @name, @version, @registry_state, @recipe_json, @artifact_path,
           @calibration_ref, @model_card_path, @experiment_run_id, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        name: entity.name,
        version: entity.version,
        registry_state: entity.registryState,
        recipe_json: toJsonColumn(entity.recipe),
        artifact_path: nullableText(entity.artifactPath),
        calibration_ref: nullableText(entity.calibrationRef),
        model_card_path: nullableText(entity.modelCardPath),
        experiment_run_id: nullableText(links.experimentRunId),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads a model version by id. */
  getById(id: string): ModelVersion | undefined {
    const row = this.firstRow('SELECT * FROM model_versions WHERE id = @id', { id });
    return row ? toModelVersion(row) : undefined;
  }

  /**
   * Reads a model version by its `(name, version)` pair.
   *
   * This is the identity the prediction actor carries: constitution II fixes
   * the model reference convention `model:<id>@<version>`.
   */
  findByNameAndVersion(name: string, version: string): ModelVersion | undefined {
    const row = this.firstRow('SELECT * FROM model_versions WHERE name = @name AND version = @version', {
      name,
      version,
    });
    return row ? toModelVersion(row) : undefined;
  }

  /** Every model version produced by one experiment run. */
  listByExperimentRun(experimentRunId: string): ModelVersion[] {
    return this.allRows(
      'SELECT * FROM model_versions WHERE experiment_run_id = @experiment_run_id ORDER BY created_at',
      { experiment_run_id: experimentRunId },
    ).map(toModelVersion);
  }

  private assertExperimentRunExists(experimentRunId: string): void {
    const row = this.db
      .prepare('SELECT 1 FROM experiment_runs WHERE id = @id')
      .get({ id: experimentRunId });
    if (!row) {
      throw new StoreValidationError(
        `Model version links to an unknown experiment run '${experimentRunId}'. ` +
          'The store-owned link must point at a run that exists in the store.',
        [],
      );
    }
  }
}

/** Maps a `model_versions` row to the contract entity. */
export function toModelVersion(row: Row): ModelVersion {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    version: row['version'] as string,
    registryState: row['registry_state'] as ModelVersion['registryState'],
    recipe: fromJsonColumn<JsonValue>(row['recipe_json'] as string | null),
    artifactPath: optionalText(row['artifact_path']),
    calibrationRef: optionalText(row['calibration_ref']),
    modelCardPath: optionalText(row['model_card_path']),
    createdAt: row['created_at'] as string,
  };
}
