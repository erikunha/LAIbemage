/**
 * The `label_view` reader: a read-only join for UI convenience (spec 002,
 * task 3.2).
 *
 * The view joins samples, assets, annotations and predictions in one query
 * so a surface can render "what does the platform know about this image?"
 * without hand-writing the join. It is **read-only by construction**: it is a
 * SQL VIEW, and SQLite rejects any INSERT/UPDATE/DELETE against a view that
 * has no INSTEAD OF trigger (`cannot modify label_view because it is a
 * view`). The view never writes — not even a convenience update.
 *
 * Note the fan-out: a sample with three annotations and two predictions
 * produces six rows. That is inherent to joining both label kinds; filter
 * with `annotationId` / `predictionId` when a single row is needed.
 *
 * ## The sentinel rule
 *
 * The view inherits the NOT NULL columns of the tables it joins, including
 * the ones that carry the "not recorded" sentinel (`annotations.session_id`).
 * Every text column of the view is therefore read through `optionalText`, so
 * the sentinel comes back as `undefined` and never as an empty session id.
 */

import type { SqliteDatabase } from '../db.js';
import { BaseRepository, optionalText, type Row } from './base.js';

/** One row of the `label_view`. */
export interface LabelViewRow {
  readonly sampleId: string;
  readonly assetId: string;
  readonly split?: string;
  readonly assetPath?: string;
  readonly assetSha256?: string;
  readonly assetUnhashed: boolean;
  readonly annotationId?: string;
  readonly annotationLabelKey?: string;
  readonly annotationActorKind?: string;
  readonly annotationActorRef?: string;
  readonly annotationSurface?: string;
  readonly annotationSessionId?: string;
  readonly annotationCreatedAt?: string;
  readonly annotationSupersededBy?: string;
  readonly predictionId?: string;
  readonly predictionLabelKey?: string;
  readonly predictionProbabilityRaw?: number;
  readonly predictionProbabilityCalibrated?: number;
  readonly predictionLatencyMs?: number;
  readonly predictionCostMicroUsd?: number;
  readonly predictionModelVersionId?: string;
  readonly modelName?: string;
  readonly modelVersion?: string;
}

/** Filter accepted by {@link LabelViewRepository.list}. */
export interface LabelViewFilter {
  readonly sampleId?: string;
  readonly assetId?: string;
}

/** The read-only `label_view`. */
export class LabelViewRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Reads rows of the view, optionally filtered by sample or asset. */
  list(filter: LabelViewFilter = {}): LabelViewRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.sampleId !== undefined) {
      clauses.push('sample_id = @sample_id');
      params['sample_id'] = filter.sampleId;
    }
    if (filter.assetId !== undefined) {
      clauses.push('asset_id = @asset_id');
      params['asset_id'] = filter.assetId;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.allRows(`SELECT * FROM label_view${where} ORDER BY sample_id, annotation_id, prediction_id`, params).map(
      toLabelViewRow,
    );
  }

  /** Reads every row of the view for one sample. */
  listBySample(sampleId: string): LabelViewRow[] {
    return this.list({ sampleId });
  }
}

/** Maps a `label_view` row to a typed row object. */
export function toLabelViewRow(row: Row): LabelViewRow {
  // Every text column goes through `optionalText`, so the "not recorded"
  // sentinel (`''`) of a NOT NULL column — `annotations.session_id` — reads
  // back as `undefined` and never as an empty session id (see the sentinel
  // rule in `./base.ts`).
  return {
    sampleId: row['sample_id'] as string,
    assetId: row['asset_id'] as string,
    split: optionalText(row['split']),
    assetPath: optionalText(row['asset_path']),
    assetSha256: optionalText(row['asset_sha256']),
    assetUnhashed: row['asset_unhashed'] === 1,
    annotationId: optionalText(row['annotation_id']),
    annotationLabelKey: optionalText(row['annotation_label_key']),
    annotationActorKind: optionalText(row['annotation_actor_kind']),
    annotationActorRef: optionalText(row['annotation_actor_ref']),
    annotationSurface: optionalText(row['annotation_surface']),
    annotationSessionId: optionalText(row['annotation_session_id']),
    annotationCreatedAt: optionalText(row['annotation_created_at']),
    annotationSupersededBy: optionalText(row['annotation_superseded_by']),
    predictionId: optionalText(row['prediction_id']),
    predictionLabelKey: optionalText(row['prediction_label_key']),
    predictionProbabilityRaw: (row['prediction_probability_raw'] as number | null) ?? undefined,
    predictionProbabilityCalibrated:
      (row['prediction_probability_calibrated'] as number | null) ?? undefined,
    predictionLatencyMs: (row['prediction_latency_ms'] as number | null) ?? undefined,
    predictionCostMicroUsd: (row['prediction_cost_micro_usd'] as number | null) ?? undefined,
    predictionModelVersionId: optionalText(row['prediction_model_version_id']),
    modelName: optionalText(row['model_name']),
    modelVersion: optionalText(row['model_version']),
  };
}
