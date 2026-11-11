/**
 * Derived artifacts: thumbnails, embeddings, masks, crops and reports
 * (spec 002, US4 / task 5.1).
 *
 * ## Lineage is structural, not conventional (constitution II)
 *
 * A derived artifact records WHICH originals it came from
 * (`sourceAssetIds`), WHICH transform produced it (`transform`), and WHICH
 * exact configuration that transform ran with (`transformFingerprint`).
 * Without those three, the artifact cannot be created at all — the contract
 * requires them and the database makes the columns NOT NULL.
 *
 * ## The source-existence rule (store-level, stronger than the contract)
 *
 * The source list is a JSON array, so it cannot carry a SQL foreign key.
 * The repository therefore checks that every referenced asset actually exists
 * before writing: a dangling source id would be a silent hole in the audit
 * trail, and "which original produced this embedding?" must always have an
 * answer. `sourceSnapshotId` stays nullable — a derivation may reference
 * assets without a snapshot — but at least ONE source is always required.
 *
 * ## The `encoderModelVersionId` link
 *
 * The contracts' `DerivedArtifact` carries no pointer to the model that
 * produced it, but the auditor walk (spec 002, task 5.2) must reach the
 * encoder of an embedding. The store therefore owns ONE extra, nullable,
 * store-level link column (`derived_artifacts.encoder_model_version_id`),
 * documented as such and never leaked into the returned entity.
 *
 * A derived artifact is immutable — there is no update method.
 */

import { DerivedArtifactSchema, type DerivedArtifact } from '@vision-lens/contracts';
import type { SqliteDatabase } from '../db.js';
import { StoreValidationError } from '../errors.js';
import { fromJsonColumn, toRequiredJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type Row,
} from './base.js';

/** Store-owned links of a derived artifact (not part of the contract entity). */
export interface DerivedArtifactLinks {
  /** The model version that produced the artifact (the encoder of an embedding). */
  readonly encoderModelVersionId?: string;
}

/** The `derived_artifacts` table. */
export class DerivedArtifactsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts a derived artifact. */
  insert(artifact: DerivedArtifact, links: DerivedArtifactLinks = {}): DerivedArtifact {
    const entity = parseEntity(DerivedArtifactSchema, artifact, 'DerivedArtifact');

    if (entity.sourceAssetIds.length === 0) {
      throw new StoreValidationError(
        'A derived artifact must have at least one source asset (constitution II: lineage is structural).',
        [],
      );
    }
    this.assertSourcesExist(entity.sourceAssetIds);

    // The store-owned link is validated BEFORE the write: a typo must produce
    // the store's own actionable error, not a raw `SQLITE_CONSTRAINT_FOREIGNKEY`
    // from the driver.
    if (links.encoderModelVersionId !== undefined) {
      this.assertEncoderExists(links.encoderModelVersionId);
    }

    // The contract's `sourceSnapshotId` is validated the same way, BEFORE the
    // write: the column carries a real foreign key, so a typo would otherwise
    // surface as a raw `SQLITE_CONSTRAINT_FOREIGNKEY` from the driver — an
    // error that names the constraint but not the mistake.
    if (entity.sourceSnapshotId !== undefined) {
      this.assertSourceSnapshotExists(entity.sourceSnapshotId);
    }

    this.db
      .prepare(
        `INSERT INTO derived_artifacts (
           id, kind, source_asset_ids_json, source_snapshot_id, transform,
           transform_fingerprint, encoder_model_version_id, created_at, updated_at
         ) VALUES (
           @id, @kind, @source_asset_ids_json, @source_snapshot_id, @transform,
           @transform_fingerprint, @encoder_model_version_id, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        kind: entity.kind,
        source_asset_ids_json: toRequiredJsonColumn(entity.sourceAssetIds, 'source_asset_ids_json'),
        source_snapshot_id: nullableText(entity.sourceSnapshotId),
        transform: entity.transform,
        transform_fingerprint: entity.transformFingerprint,
        encoder_model_version_id: nullableText(links.encoderModelVersionId),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads a derived artifact by id. */
  getById(id: string): DerivedArtifact | undefined {
    const row = this.firstRow('SELECT * FROM derived_artifacts WHERE id = @id', { id });
    return row ? toDerivedArtifact(row) : undefined;
  }

  /** Every artifact derived from one asset. */
  listBySourceAsset(assetId: string): DerivedArtifact[] {
    return this.allRows(
      `SELECT da.* FROM derived_artifacts da
         JOIN json_each(da.source_asset_ids_json) j ON j.value = @asset_id
        ORDER BY da.created_at`,
      { asset_id: assetId },
    ).map(toDerivedArtifact);
  }

  /** Every artifact produced from one snapshot. */
  listBySnapshot(snapshotId: string): DerivedArtifact[] {
    return this.allRows(
      'SELECT * FROM derived_artifacts WHERE source_snapshot_id = @source_snapshot_id ORDER BY created_at',
      { source_snapshot_id: snapshotId },
    ).map(toDerivedArtifact);
  }

  /** Every artifact produced by one encoder. */
  listByEncoder(modelVersionId: string): DerivedArtifact[] {
    return this.allRows(
      'SELECT * FROM derived_artifacts WHERE encoder_model_version_id = @encoder_model_version_id ORDER BY created_at',
      { encoder_model_version_id: modelVersionId },
    ).map(toDerivedArtifact);
  }

  private assertSourcesExist(sourceAssetIds: readonly string[]): void {
    const find = this.db.prepare('SELECT 1 FROM assets WHERE id = ?');
    for (const assetId of sourceAssetIds) {
      if (!find.get(assetId)) {
        throw new StoreValidationError(
          `Derived artifact references an unknown source asset '${assetId}'. ` +
            'Lineage must point at assets that exist in the store.',
          [],
        );
      }
    }
  }

  private assertEncoderExists(modelVersionId: string): void {
    const row = this.db.prepare('SELECT 1 FROM model_versions WHERE id = ?').get(modelVersionId);
    if (!row) {
      throw new StoreValidationError(
        `Derived artifact links to an unknown encoder model version '${modelVersionId}'. ` +
          'The store-owned link must point at a model version that exists in the store.',
        [],
      );
    }
  }

  /**
   * Checks that the contract's `sourceSnapshotId` points at a snapshot that
   * exists.
   *
   * The column carries a real foreign key, but the store still looks the
   * target up FIRST: the driver would otherwise reject the write with a raw
   * `SQLITE_CONSTRAINT_FOREIGNKEY`, an error that names the constraint but not
   * the mistake. The store raises its own error instead, naming the missing
   * snapshot id and the field that carries it.
   */
  private assertSourceSnapshotExists(snapshotId: string): void {
    const row = this.db.prepare('SELECT 1 FROM dataset_snapshots WHERE id = ?').get(snapshotId);
    if (!row) {
      throw new StoreValidationError(
        `Derived artifact references an unknown source snapshot '${snapshotId}'. ` +
          'The sourceSnapshotId must point at a dataset snapshot that exists in the store.',
        [
          {
            path: ['sourceSnapshotId'],
            code: 'custom',
            message: `unknown dataset snapshot '${snapshotId}'`,
          },
        ],
      );
    }
  }
}

/** Maps a `derived_artifacts` row to the contract entity. */
export function toDerivedArtifact(row: Row): DerivedArtifact {
  return {
    id: row['id'] as string,
    kind: row['kind'] as DerivedArtifact['kind'],
    sourceAssetIds: fromJsonColumn<string[]>(row['source_asset_ids_json'] as string) ?? [],
    sourceSnapshotId: optionalText(row['source_snapshot_id']),
    transform: row['transform'] as string,
    transformFingerprint: row['transform_fingerprint'] as string,
    createdAt: row['created_at'] as string,
  };
}
