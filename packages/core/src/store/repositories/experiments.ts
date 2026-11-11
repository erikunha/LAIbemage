/**
 * Experiment runs: one run of the pipeline (spec 002).
 *
 * A run carries the FULL semantic configuration fingerprint (constitution IV)
 * and the snapshot it consumed, so any metric computed from it can be traced
 * back to the exact data and configuration it came from (constitution I).
 *
 * A run is append-only in its identity but its STATUS changes over time
 * (queued → running → succeeded/failed/cancelled/abstained). `updateStatus`
 * is the one mutation this repository exposes; it bumps `updated_at` and never
 * touches the run's identity or fingerprint.
 */

import {
  ExperimentRunSchema,
  type ExperimentRun,
  type JobState,
} from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { nextTimestamp } from '../clock.js';
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

/** The `experiment_runs` table. */
export class ExperimentsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts an experiment run. */
  insert(run: ExperimentRun): ExperimentRun {
    const entity = parseEntity(ExperimentRunSchema, run, 'ExperimentRun');

    this.db
      .prepare(
        `INSERT INTO experiment_runs (
           id, kind, input_snapshot_id, config_fingerprint, status,
           metrics_summary_json, started_at, ended_at, created_at, updated_at
         ) VALUES (
           @id, @kind, @input_snapshot_id, @config_fingerprint, @status,
           @metrics_summary_json, @started_at, @ended_at, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        kind: entity.kind,
        input_snapshot_id: nullableText(entity.inputSnapshotId),
        config_fingerprint: entity.configFingerprint,
        status: entity.status,
        metrics_summary_json: toJsonColumn(entity.metricsSummaryJson),
        started_at: entity.startedAt,
        ended_at: nullableText(entity.endedAt),
        created_at: entity.startedAt,
        updated_at: entity.startedAt,
      });

    return entity;
  }

  /** Reads an experiment run by id. */
  getById(id: string): ExperimentRun | undefined {
    const row = this.firstRow('SELECT * FROM experiment_runs WHERE id = @id', { id });
    return row ? toExperimentRun(row) : undefined;
  }

  /**
   * Updates the status of a run and bumps `updated_at`.
   *
   * `endedAt` is stamped when the run reaches a terminal state and was not
   * given one yet.
   */
  updateStatus(id: string, status: JobState, endedAt?: string): ExperimentRun {
    const run = this.getById(id);
    if (!run) {
      throw new StoreValidationError(`Cannot update experiment run '${id}': no such run.`, []);
    }
    const stamp = nextTimestamp();
    const ended = endedAt ?? (isTerminal(status) ? stamp : run.endedAt);
    this.db
      .prepare('UPDATE experiment_runs SET status = @status, ended_at = @ended_at, updated_at = @updated_at WHERE id = @id')
      .run({ status, ended_at: nullableText(ended), updated_at: stamp, id });
    return this.getById(id)!;
  }

  /** Every run that consumed one snapshot. */
  listBySnapshot(snapshotId: string): ExperimentRun[] {
    return this.allRows(
      'SELECT * FROM experiment_runs WHERE input_snapshot_id = @input_snapshot_id ORDER BY started_at',
      { input_snapshot_id: snapshotId },
    ).map(toExperimentRun);
  }
}

/** True for the states a run cannot leave. */
function isTerminal(status: JobState): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** Maps an `experiment_runs` row to the contract entity. */
export function toExperimentRun(row: Row): ExperimentRun {
  return {
    id: row['id'] as string,
    kind: row['kind'] as ExperimentRun['kind'],
    inputSnapshotId: optionalText(row['input_snapshot_id']),
    configFingerprint: row['config_fingerprint'] as string,
    status: row['status'] as JobState,
    metricsSummaryJson: fromJsonColumn<JsonValue>(row['metrics_summary_json'] as string | null),
    startedAt: row['started_at'] as string,
    endedAt: optionalText(row['ended_at']),
  };
}
