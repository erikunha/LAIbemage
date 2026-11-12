/**
 * Experiment runs: one run of the pipeline (spec 002).
 *
 * A run carries the FULL semantic configuration fingerprint (constitution IV)
 * and the snapshot it consumed, so any metric computed from it can be traced
 * back to the exact data and configuration it came from (constitution I).
 *
 * A run is append-only in its identity but its STATUS changes over time
 * (queued → running → cancel_requested → succeeded/failed/cancelled/abstained).
 * Every transition lands in the append-only `job_transitions` audit ledger
 * (spec 018, FR-012), and a run that reached a terminal state never leaves
 * it: `updateStatus` refuses the transition, so terminal really is immutable.
 */

import {
  ExperimentRunSchema,
  type ExperimentRun,
  type JobState,
} from '@vision-lens/contracts';
import type { SqliteDatabase } from '../db.js';
import { nextTimestamp } from '../clock.js';
import { StoreValidationError } from '../errors.js';
import { newEntityId } from '../ids.js';
import { fromJsonColumn, toJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type JsonValue,
  type Row,
} from './base.js';

/**
 * One row of the `job_transitions` audit ledger (spec 018, task 4.3): a
 * single status transition of one experiment run, appended by this
 * repository and immutable at the database level (UPDATE and DELETE are
 * refused by triggers; see migration 0003).
 *
 * Store-owned, like the legacy carry-over of 0002: it is not part of the
 * public contract surface.
 */
export interface JobTransition {
  readonly id: string;
  readonly runId: string;
  readonly fromStatus: JobState;
  readonly toStatus: JobState;
  /** Why the transition happened, when the caller said so. */
  readonly reason: string | undefined;
  readonly recordedAt: string;
}

/** The states a run cannot leave (the immutable terminal states). */
export const TERMINAL_JOB_STATES = ['succeeded', 'failed', 'cancelled', 'abstained'] as const;

/** The states a cancellation may start from. */
const CANCELLABLE_STATES = ['queued', 'running'] as const;

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
   * Updates the status of a run, appends the transition to the audit ledger
   * and bumps `updated_at`.
   *
   * `endedAt` is stamped when the run reaches a terminal state and was not
   * given one yet. A run already IN a terminal state refuses the update:
   * terminal states are immutable (spec 018, FR-012).
   */
  updateStatus(id: string, status: JobState, endedAt?: string): ExperimentRun {
    return this.transition(id, status, endedAt);
  }

  /**
   * Marks a run as `cancel_requested` (the intermediate cancellation state,
   * spec 018 FR-012): the operator asked to stop, the stop itself is still
   * pending. Only a queued or running run may enter it; the confirmed stop is
   * {@link completeCancel}.
   */
  requestCancel(id: string, reason?: string): ExperimentRun {
    const run = this.getById(id);
    if (!run) {
      throw new StoreValidationError(`Cannot cancel experiment run '${id}': no such run.`, []);
    }
    if (isTerminal(run.status)) {
      throw new StoreValidationError(
        `Cannot cancel experiment run '${id}': it is already in the terminal state '${run.status}'.`,
        [],
      );
    }
    if (run.status === 'cancel_requested') {
      throw new StoreValidationError(
        `Cannot cancel experiment run '${id}': a cancellation is already requested.`,
        [],
      );
    }
    if (!(CANCELLABLE_STATES as readonly string[]).includes(run.status)) {
      throw new StoreValidationError(
        `Cannot cancel experiment run '${id}' from the state '${run.status}'.`,
        [],
      );
    }
    return this.transition(id, 'cancel_requested', undefined, reason);
  }

  /**
   * Completes a cancellation: `cancel_requested` becomes the immutable
   * terminal `cancelled`, `endedAt` is stamped, and both transitions are in
   * the ledger. A run that never entered `cancel_requested` is refused: this
   * method confirms a pending cancellation, it does not bypass it.
   */
  completeCancel(id: string, reason?: string): ExperimentRun {
    const run = this.getById(id);
    if (!run) {
      throw new StoreValidationError(`Cannot cancel experiment run '${id}': no such run.`, []);
    }
    if (run.status !== 'cancel_requested') {
      throw new StoreValidationError(
        `Cannot complete the cancellation of run '${id}': its status is '${run.status}', ` +
          'not cancel_requested; pass through cancel_requested first',
        [],
      );
    }
    return this.transition(id, 'cancelled', undefined, reason);
  }

  /** The audit ledger of one run, oldest transition first. */
  listTransitions(runId: string): JobTransition[] {
    return this.allRows(
      'SELECT * FROM job_transitions WHERE run_id = @run_id ORDER BY recorded_at, id',
      { run_id: runId },
    ).map(toJobTransition);
  }

  /** Every run that consumed one snapshot. */
  listBySnapshot(snapshotId: string): ExperimentRun[] {
    return this.allRows(
      'SELECT * FROM experiment_runs WHERE input_snapshot_id = @input_snapshot_id ORDER BY started_at',
      { input_snapshot_id: snapshotId },
    ).map(toExperimentRun);
  }

  /**
   * The one status mutation: refuses a transition out of a terminal state,
   * updates the row, and appends the ledger row ATOMICALLY (one transaction,
   * so the run and its ledger can never disagree).
   */
  private transition(id: string, status: JobState, endedAt?: string, reason?: string): ExperimentRun {
    const run = this.getById(id);
    if (!run) {
      throw new StoreValidationError(`Cannot update experiment run '${id}': no such run.`, []);
    }
    if (isTerminal(run.status)) {
      throw new StoreValidationError(
        `Cannot update experiment run '${id}' from the terminal state '${run.status}': ` +
          'terminal job states are immutable',
        [],
      );
    }
    const stamp = nextTimestamp();
    const ended = endedAt ?? (isTerminal(status) ? stamp : run.endedAt);
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE experiment_runs SET status = @status, ended_at = @ended_at, updated_at = @updated_at WHERE id = @id',
        )
        .run({ status, ended_at: nullableText(ended), updated_at: stamp, id });
      this.db
        .prepare(
          `INSERT INTO job_transitions (id, run_id, from_status, to_status, reason, recorded_at)
           VALUES (@id, @run_id, @from_status, @to_status, @reason, @recorded_at)`,
        )
        .run({
          id: newEntityId(),
          run_id: id,
          from_status: run.status,
          to_status: status,
          reason: nullableText(reason),
          recorded_at: stamp,
        });
    });
    apply();
    return this.getById(id)!;
  }
}

/** True for the states a run cannot leave. */
function isTerminal(status: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(status);
}

/** Maps a `job_transitions` row to the ledger record. */
function toJobTransition(row: Row): JobTransition {
  return {
    id: row['id'] as string,
    runId: row['run_id'] as string,
    fromStatus: row['from_status'] as JobState,
    toStatus: row['to_status'] as JobState,
    reason: optionalText(row['reason']),
    recordedAt: row['recorded_at'] as string,
  };
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
