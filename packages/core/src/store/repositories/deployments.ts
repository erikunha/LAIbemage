/**
 * Deployments: a model version made available on a target (spec 002).
 *
 * `active` marks the deployment currently serving traffic and
 * `pinnedFromId` records the deployment a promotion was pinned from, so a
 * rollback is traceable rather than a mystery. `setActive` is the one
 * mutation this repository exposes; it bumps `updated_at` and never touches
 * the deployment's identity or configuration.
 */

import { DeploymentSchema, type Deployment } from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { nextTimestamp } from '../clock.js';
import { StoreValidationError } from '../errors.js';
import { fromJsonColumn, toRequiredJsonColumn } from '../json.js';
import {
  BaseRepository,
  boolToInt,
  intToBool,
  nullableText,
  optionalText,
  parseEntity,
  type JsonValue,
  type Row,
} from './base.js';

/** The `deployments` table. */
export class DeploymentsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts a deployment. */
  insert(deployment: Deployment): Deployment {
    const entity = parseEntity(DeploymentSchema, deployment, 'Deployment');

    this.db
      .prepare(
        `INSERT INTO deployments (
           id, model_version_id, target, config_json, active, promoted_at,
           pinned_from_id, created_at, updated_at
         ) VALUES (
           @id, @model_version_id, @target, @config_json, @active, @promoted_at,
           @pinned_from_id, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        model_version_id: entity.modelVersionId,
        target: entity.target,
        config_json: toRequiredJsonColumn(entity.configJson, 'config_json'),
        active: boolToInt(entity.active),
        promoted_at: nullableText(entity.promotedAt),
        pinned_from_id: nullableText(entity.pinnedFromId),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads a deployment by id. */
  getById(id: string): Deployment | undefined {
    const row = this.firstRow('SELECT * FROM deployments WHERE id = @id', { id });
    return row ? toDeployment(row) : undefined;
  }

  /** Every deployment of one model version. */
  listByModelVersion(modelVersionId: string): Deployment[] {
    return this.allRows('SELECT * FROM deployments WHERE model_version_id = @model_version_id ORDER BY created_at', {
      model_version_id: modelVersionId,
    }).map(toDeployment);
  }

  /** The deployment currently serving a target, if any. */
  findActive(target: string): Deployment | undefined {
    const row = this.firstRow(
      'SELECT * FROM deployments WHERE target = @target AND active = 1 ORDER BY created_at DESC LIMIT 1',
      { target },
    );
    return row ? toDeployment(row) : undefined;
  }

  /** Activates or deactivates a deployment and bumps `updated_at`. */
  setActive(id: string, active: boolean, promotedAt?: string): Deployment {
    const deployment = this.getById(id);
    if (!deployment) {
      throw new StoreValidationError(`Cannot update deployment '${id}': no such deployment.`, []);
    }
    const stamp = nextTimestamp();
    this.db
      .prepare('UPDATE deployments SET active = @active, promoted_at = @promoted_at, updated_at = @updated_at WHERE id = @id')
      .run({
        active: boolToInt(active),
        promoted_at: nullableText(promotedAt ?? deployment.promotedAt),
        updated_at: stamp,
        id,
      });
    return this.getById(id)!;
  }
}

/** Maps a `deployments` row to the contract entity. */
export function toDeployment(row: Row): Deployment {
  return {
    id: row['id'] as string,
    modelVersionId: row['model_version_id'] as string,
    target: row['target'] as string,
    configJson: fromJsonColumn<JsonValue>(row['config_json'] as string) as JsonValue,
    active: intToBool(row['active']),
    promotedAt: optionalText(row['promoted_at']),
    pinnedFromId: optionalText(row['pinned_from_id']),
    createdAt: row['created_at'] as string,
  };
}
