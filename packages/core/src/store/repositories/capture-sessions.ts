/**
 * Capture sessions: one device/camera producing a stream of frames
 * (spec 002).
 *
 * A session groups the assets captured together. It is referenced by
 * `assets.capture_session_id` (ON DELETE SET NULL: deleting a session must
 * never destroy the assets it produced — originals are immutable).
 */

import { CaptureSessionSchema, type CaptureSession } from '@vision-lens/contracts';
import type { SqliteDatabase } from '../db.js';
import { nextTimestamp } from '../clock.js';
import { fromJsonColumn, toJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type JsonValue,
  type Row,
} from './base.js';

/** The `capture_sessions` table. */
export class CaptureSessionsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts a capture session. */
  insert(session: CaptureSession): CaptureSession {
    const entity = parseEntity(CaptureSessionSchema, session, 'CaptureSession');
    // The contract has no `createdAt` for a session; the store stamps one.
    const stamp = nextTimestamp();

    this.db
      .prepare(
        `INSERT INTO capture_sessions (
           id, started_at, ended_at, source, context_json, created_at, updated_at
         ) VALUES (
           @id, @started_at, @ended_at, @source, @context_json, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        started_at: entity.startedAt,
        ended_at: nullableText(entity.endedAt),
        source: entity.source,
        context_json: toJsonColumn(entity.contextJson),
        created_at: stamp,
        updated_at: stamp,
      });

    return entity;
  }

  /** Reads a session by id. */
  getById(id: string): CaptureSession | undefined {
    const row = this.firstRow('SELECT * FROM capture_sessions WHERE id = @id', { id });
    return row ? toCaptureSession(row) : undefined;
  }

  /** Every session of one source (device label). */
  listBySource(source: string): CaptureSession[] {
    return this.allRows('SELECT * FROM capture_sessions WHERE source = @source ORDER BY started_at', {
      source,
    }).map(toCaptureSession);
  }
}

/** Maps a `capture_sessions` row to the contract entity. */
export function toCaptureSession(row: Row): CaptureSession {
  return {
    id: row['id'] as string,
    startedAt: row['started_at'] as string,
    endedAt: optionalText(row['ended_at']),
    source: row['source'] as string,
    contextJson: fromJsonColumn<JsonValue>(row['context_json'] as string | null),
  };
}
