/**
 * Samples: a labelled unit of observation — one asset, optionally one region
 * of it (spec 002).
 *
 * A sample is immutable in its identity. Its *snapshot membership* is
 * recorded ONCE, at insert time, as a JSON array (`snapshot_ids_json`) — the
 * same shape the contracts use — and it is read back through SQLite's JSON
 * functions when the auditor walks a snapshot to its assets.
 *
 * **Membership is FROZEN at insert.** No repository method updates
 * `snapshot_ids_json`: a snapshot is immutable (constitution I), so the set of
 * samples that belong to it is decided when the sample is written, and adding
 * a sample to a snapshot later would silently change what that snapshot means.
 * A new membership is expressed by a NEW sample row (or, in a later spec, by
 * a new snapshot that points at its parent) — never by editing the old one.
 *
 * Because the membership is a JSON array it cannot carry a SQL foreign key,
 * so the repository VERIFIES that every referenced snapshot exists before it
 * writes: a phantom snapshot id would silently empty the auditor walk
 * ("which assets does this snapshot contain?" would answer "none").
 */

import { SampleSchema, type Region, type Sample } from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { StoreValidationError } from '../errors.js';
import { fromJsonColumn, toJsonColumn, toRequiredJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type Row,
} from './base.js';

/** The `samples` table. */
export class SamplesRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts a sample. */
  insert(sample: Sample): Sample {
    const entity = parseEntity(SampleSchema, sample, 'Sample');

    this.assertSnapshotsExist(entity.snapshotIds);

    this.db
      .prepare(
        `INSERT INTO samples (
           id, asset_id, region_json, split, snapshot_ids_json,
           source_capture_frame, created_at, updated_at
         ) VALUES (
           @id, @asset_id, @region_json, @split, @snapshot_ids_json,
           @source_capture_frame, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        asset_id: entity.assetId,
        region_json: toJsonColumn(entity.region),
        split: nullableText(entity.split),
        snapshot_ids_json: toRequiredJsonColumn(entity.snapshotIds, 'snapshot_ids_json'),
        source_capture_frame: nullableText(entity.sourceCaptureFrame),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads a sample by id. */
  getById(id: string): Sample | undefined {
    const row = this.firstRow('SELECT * FROM samples WHERE id = @id', { id });
    return row ? toSample(row) : undefined;
  }

  /** Every sample of one asset. */
  listByAsset(assetId: string): Sample[] {
    return this.allRows('SELECT * FROM samples WHERE asset_id = @asset_id ORDER BY created_at', {
      asset_id: assetId,
    }).map(toSample);
  }

  /**
   * Every sample that belongs to a snapshot.
   *
   * The membership is a JSON array on the row, so the lookup goes through
   * SQLite's `json_each` table-valued function — a real join, not an
   * application-side scan.
   */
  listBySnapshot(snapshotId: string): Sample[] {
    return this.allRows(
      `SELECT s.* FROM samples s
         JOIN json_each(s.snapshot_ids_json) j ON j.value = @snapshot_id
        ORDER BY s.created_at`,
      { snapshot_id: snapshotId },
    ).map(toSample);
  }

  private assertSnapshotsExist(snapshotIds: readonly string[]): void {
    const find = this.db.prepare('SELECT 1 FROM dataset_snapshots WHERE id = ?');
    for (const snapshotId of snapshotIds) {
      if (!find.get(snapshotId)) {
        throw new StoreValidationError(
          `Sample references an unknown dataset snapshot '${snapshotId}'. ` +
            'Snapshot membership must point at snapshots that exist in the store, ' +
            'otherwise the auditor walk silently returns nothing.',
          [],
        );
      }
    }
  }
}

/** Maps a `samples` row to the contract entity. */
export function toSample(row: Row): Sample {
  return {
    id: row['id'] as string,
    assetId: row['asset_id'] as string,
    region: fromJsonColumn<Region>(row['region_json'] as string | null),
    split: optionalText(row['split']) as Sample['split'],
    snapshotIds: fromJsonColumn<string[]>(row['snapshot_ids_json'] as string) ?? [],
    sourceCaptureFrame: optionalText(row['source_capture_frame']),
    createdAt: row['created_at'] as string,
  };
}
