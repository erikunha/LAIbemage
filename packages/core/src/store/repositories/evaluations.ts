/**
 * Evaluation runs: the measured evaluation of one experiment (spec 002).
 *
 * "A metric without its reproduction record is a hypothesis, not a result"
 * (constitution I). The evaluation row therefore stays joined to the
 * experiment run that carries the config fingerprint and the input snapshot.
 *
 * Evaluations are immutable: a re-run produces a new row.
 */

import { EvaluationRunSchema, type EvaluationRun } from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { fromJsonColumn, toRequiredJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type JsonValue,
  type Row,
} from './base.js';

/** The `evaluation_runs` table. */
export class EvaluationsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts an evaluation run. */
  insert(evaluation: EvaluationRun): EvaluationRun {
    const entity = parseEntity(EvaluationRunSchema, evaluation, 'EvaluationRun');

    this.db
      .prepare(
        `INSERT INTO evaluation_runs (
           id, experiment_run_id, protocol, results_json, report_path, created_at, updated_at
         ) VALUES (
           @id, @experiment_run_id, @protocol, @results_json, @report_path, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        experiment_run_id: entity.experimentRunId,
        protocol: entity.protocol,
        results_json: toRequiredJsonColumn(entity.resultsJson, 'results_json'),
        report_path: nullableText(entity.reportPath),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads an evaluation run by id. */
  getById(id: string): EvaluationRun | undefined {
    const row = this.firstRow('SELECT * FROM evaluation_runs WHERE id = @id', { id });
    return row ? toEvaluationRun(row) : undefined;
  }

  /** Every evaluation of one experiment run. */
  listByExperimentRun(experimentRunId: string): EvaluationRun[] {
    return this.allRows(
      'SELECT * FROM evaluation_runs WHERE experiment_run_id = @experiment_run_id ORDER BY created_at',
      { experiment_run_id: experimentRunId },
    ).map(toEvaluationRun);
  }
}

/** Maps an `evaluation_runs` row to the contract entity. */
export function toEvaluationRun(row: Row): EvaluationRun {
  return {
    id: row['id'] as string,
    experimentRunId: row['experiment_run_id'] as string,
    protocol: row['protocol'] as string,
    resultsJson: fromJsonColumn<JsonValue>(row['results_json'] as string) as JsonValue,
    reportPath: optionalText(row['report_path']),
    createdAt: row['created_at'] as string,
  };
}
