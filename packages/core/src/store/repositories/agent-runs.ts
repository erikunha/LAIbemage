/**
 * Agent runs: one agent investigation (spec 002, constitution VI).
 *
 * The budget, the tool calls and the approvals are first-class rows, not
 * log lines: an agent never escalates past `approval-required` on its own,
 * and the decision trail must be queryable. `updateStatus` is the one
 * mutation this repository exposes; it bumps `updated_at` and never touches
 * the run's goal, budget or approval trail.
 */

import {
  AgentRunSchema,
  type AgentRun,
  type Approval,
  type JobState,
  type ToolCall,
} from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { nextTimestamp } from '../clock.js';
import { StoreValidationError } from '../errors.js';
import { fromJsonColumn, toRequiredJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type Row,
} from './base.js';

/** The `agent_runs` table. */
export class AgentRunsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts an agent run. */
  insert(run: AgentRun): AgentRun {
    const entity = parseEntity(AgentRunSchema, run, 'AgentRun');

    this.db
      .prepare(
        `INSERT INTO agent_runs (
           id, goal, status, budget_json, tool_calls_json, approvals_json,
           report_path, created_at, updated_at
         ) VALUES (
           @id, @goal, @status, @budget_json, @tool_calls_json, @approvals_json,
           @report_path, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        goal: entity.goal,
        status: entity.status,
        budget_json: toRequiredJsonColumn(entity.budgetJson, 'budget_json'),
        tool_calls_json: toRequiredJsonColumn(entity.toolCalls, 'tool_calls_json'),
        approvals_json: toRequiredJsonColumn(entity.approvals, 'approvals_json'),
        report_path: nullableText(entity.reportPath),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads an agent run by id. */
  getById(id: string): AgentRun | undefined {
    const row = this.firstRow('SELECT * FROM agent_runs WHERE id = @id', { id });
    return row ? toAgentRun(row) : undefined;
  }

  /** Updates the status of a run and bumps `updated_at`. */
  updateStatus(id: string, status: JobState): AgentRun {
    const run = this.getById(id);
    if (!run) {
      throw new StoreValidationError(`Cannot update agent run '${id}': no such run.`, []);
    }
    this.db
      .prepare('UPDATE agent_runs SET status = @status, updated_at = @updated_at WHERE id = @id')
      .run({ status, updated_at: nextTimestamp(), id });
    return this.getById(id)!;
  }
}

/** Maps an `agent_runs` row to the contract entity. */
export function toAgentRun(row: Row): AgentRun {
  return {
    id: row['id'] as string,
    goal: row['goal'] as string,
    status: row['status'] as JobState,
    budgetJson: fromJsonColumn<unknown>(row['budget_json'] as string) as AgentRun['budgetJson'],
    toolCalls: fromJsonColumn<ToolCall[]>(row['tool_calls_json'] as string) ?? [],
    approvals: fromJsonColumn<Approval[]>(row['approvals_json'] as string) ?? [],
    reportPath: optionalText(row['report_path']),
    createdAt: row['created_at'] as string,
  };
}
