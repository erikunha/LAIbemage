/**
 * Predictions: model-produced labels (spec 002, US4).
 *
 * ## Prediction ≠ Annotation (constitution II, FR-002)
 *
 * A prediction is authored by a model. The contract refuses a human or agent
 * actor (`PredictionActorSchema`) and the database refuses it too
 * (`CHECK (actor_kind = 'model')`). Predictions live in their own table; no
 * query in this repository can return an annotation.
 *
 * ## Calibrated uncertainty and cost (constitution V, VIII)
 *
 * `probabilityRaw` is the model's own output, `probabilityCalibrated` the
 * empirically calibrated probability; the raw value alone is never treated as
 * a probability. `latencyMs` and `costMicroUsd` travel with the prediction
 * instead of living in a side table, so a cost metric never has to guess
 * which run produced it.
 *
 * ## Provenance is mandatory
 *
 * Actor, surface and timestamp are required by the contract and NOT NULL in
 * the database. A prediction without provenance cannot be written. The
 * session is part of the provenance bundle too (US4): the contract carries it
 * as an optional field and the column is NOT NULL, so the empty string is the
 * "no session recorded" sentinel — never a session id.
 *
 * ## Predictions are appended, never edited
 *
 * There is no update method: a model output is an observation. Re-running a
 * model produces a new prediction row (with a new model version if the model
 * changed).
 */

import { PredictionSchema, type Prediction } from '@vision-lens/contracts';
import type { SqliteDatabase } from '../db.js';
import { fromJsonColumn, toJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableNumber,
  parseEntity,
  type JsonValue,
  type Row,
} from './base.js';

/** The `predictions` table. */
export class PredictionsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts a prediction. */
  insert(prediction: Prediction): Prediction {
    const entity = parseEntity(PredictionSchema, prediction, 'Prediction');

    this.db
      .prepare(
        `INSERT INTO predictions (
           id, sample_id, model_version_id, label_key,
           probability_raw, probability_calibrated, latency_ms, cost_micro_usd,
           agreement_json, actor_kind, actor_ref, actor_version,
           surface, session_id, created_at, updated_at
         ) VALUES (
           @id, @sample_id, @model_version_id, @label_key,
           @probability_raw, @probability_calibrated, @latency_ms, @cost_micro_usd,
           @agreement_json, @actor_kind, @actor_ref, @actor_version,
           @surface, @session_id, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        sample_id: entity.sampleId,
        model_version_id: entity.modelVersionId,
        label_key: entity.labelKey,
        probability_raw: entity.probabilityRaw,
        probability_calibrated: nullableNumber(entity.probabilityCalibrated),
        latency_ms: nullableNumber(entity.latencyMs),
        cost_micro_usd: nullableNumber(entity.costMicroUsd),
        agreement_json: toJsonColumn(entity.agreementJson),
        actor_kind: entity.actor.kind,
        actor_ref: entity.actor.ref,
        actor_version: entity.actor.version,
        // `surface` is REQUIRED by the contract (US4: a model output always
        // came through some surface), so it is written as it is — never
        // fabricated.
        surface: entity.surface,
        // The contract marks `sessionId` optional; the column is NOT NULL and
        // uses the empty string as the "no session recorded" sentinel.
        session_id: entity.sessionId ?? '',
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads a prediction by id. */
  getById(id: string): Prediction | undefined {
    const row = this.firstRow('SELECT * FROM predictions WHERE id = @id', { id });
    return row ? toPrediction(row) : undefined;
  }

  /** Every prediction of one sample, oldest first. */
  listBySample(sampleId: string): Prediction[] {
    return this.allRows('SELECT * FROM predictions WHERE sample_id = @sample_id ORDER BY created_at, id', {
      sample_id: sampleId,
    }).map(toPrediction);
  }

  /** Every prediction produced by one model version. */
  listByModelVersion(modelVersionId: string): Prediction[] {
    return this.allRows(
      'SELECT * FROM predictions WHERE model_version_id = @model_version_id ORDER BY created_at, id',
      { model_version_id: modelVersionId },
    ).map(toPrediction);
  }
}

/**
 * Maps a `predictions` row to the contract entity.
 *
 * The mapping never invents a value: the `surface` is read as it was written
 * (the contract requires it, so the column holds a real surface) and the
 * empty-string sentinel of the NOT NULL `session_id` column is mapped back to
 * `undefined` — the entity read back therefore satisfies `PredictionSchema`.
 */
export function toPrediction(row: Row): Prediction {
  return {
    id: row['id'] as string,
    sampleId: row['sample_id'] as string,
    modelVersionId: row['model_version_id'] as string,
    labelKey: row['label_key'] as string,
    probabilityRaw: row['probability_raw'] as number,
    probabilityCalibrated: (row['probability_calibrated'] as number | null) ?? undefined,
    latencyMs: (row['latency_ms'] as number | null) ?? undefined,
    costMicroUsd: (row['cost_micro_usd'] as number | null) ?? undefined,
    agreementJson: fromJsonColumn<JsonValue>(row['agreement_json'] as string | null),
    actor: {
      kind: 'model',
      ref: row['actor_ref'] as string,
      version: row['actor_version'] as string,
    },
    surface: row['surface'] as Prediction['surface'],
    // The empty string is the "no session recorded" sentinel, not a session.
    sessionId: (row['session_id'] as string) || undefined,
    createdAt: row['created_at'] as string,
  };
}
