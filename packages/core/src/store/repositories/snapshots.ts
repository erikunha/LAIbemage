/**
 * Dataset snapshots: immutable, content-addressed views of a dataset
 * (spec 002, constitution I).
 *
 * A snapshot pins the asset set (`manifestHash`), the split assignment
 * (`splitAssignments`) and the taxonomy it was built against
 * (`ontologyVersionId`). It is never edited: a re-split or a changed
 * manifest produces a NEW snapshot that points at its parent.
 *
 * The repository therefore offers no update method.
 */

import { DatasetSnapshotSchema, type DatasetSnapshot } from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { fromJsonColumn, toJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type JsonValue,
  type Row,
} from './base.js';

/** The `dataset_snapshots` table. */
export class SnapshotsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts a dataset snapshot. */
  insert(snapshot: DatasetSnapshot): DatasetSnapshot {
    const entity = parseEntity(DatasetSnapshotSchema, snapshot, 'DatasetSnapshot');

    this.db
      .prepare(
        `INSERT INTO dataset_snapshots (
           id, manifest_hash, split_assignments, ontology_version_id,
           parent_snapshot_id, lineage_json, created_at, updated_at
         ) VALUES (
           @id, @manifest_hash, @split_assignments, @ontology_version_id,
           @parent_snapshot_id, @lineage_json, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        manifest_hash: entity.manifestHash,
        split_assignments: entity.splitAssignments,
        ontology_version_id: entity.ontologyVersionId,
        parent_snapshot_id: nullableText(entity.parentSnapshotId),
        lineage_json: toJsonColumn(entity.lineageJson),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads a snapshot by id. */
  getById(id: string): DatasetSnapshot | undefined {
    const row = this.firstRow('SELECT * FROM dataset_snapshots WHERE id = @id', { id });
    return row ? toDatasetSnapshot(row) : undefined;
  }

  /** Reads a snapshot by its manifest hash. */
  findByManifestHash(manifestHash: string): DatasetSnapshot | undefined {
    const row = this.firstRow('SELECT * FROM dataset_snapshots WHERE manifest_hash = @manifest_hash', {
      manifest_hash: manifestHash,
    });
    return row ? toDatasetSnapshot(row) : undefined;
  }

  /** The chain of snapshots leading to `id`, oldest first. */
  listLineage(id: string): DatasetSnapshot[] {
    return this.allRows(
      `WITH RECURSIVE lineage(id, parent_id, depth) AS (
         SELECT id, parent_snapshot_id, 0 FROM dataset_snapshots WHERE id = @id
         UNION ALL
         SELECT s.id, s.parent_snapshot_id, l.depth + 1
           FROM dataset_snapshots s JOIN lineage l ON s.id = l.parent_id
       )
       SELECT s.* FROM dataset_snapshots s JOIN lineage l ON s.id = l.id
        ORDER BY l.depth DESC, s.created_at, s.id`,
      { id },
    ).map(toDatasetSnapshot);
  }
}

/** Maps a `dataset_snapshots` row to the contract entity. */
export function toDatasetSnapshot(row: Row): DatasetSnapshot {
  return {
    id: row['id'] as string,
    manifestHash: row['manifest_hash'] as string,
    splitAssignments: row['split_assignments'] as string,
    ontologyVersionId: row['ontology_version_id'] as string,
    parentSnapshotId: optionalText(row['parent_snapshot_id']),
    createdAt: row['created_at'] as string,
    lineageJson: fromJsonColumn<JsonValue>(row['lineage_json'] as string | null),
  };
}
