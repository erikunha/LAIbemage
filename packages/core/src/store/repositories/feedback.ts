/**
 * Feedback events: append-only signals about a sample (spec 002).
 *
 * Feedback is an EVENT, not an edit: a `correction` points at the sample it
 * disputes, and the authoritative new label is a separate annotation row
 * (constitution II, FR-006). Nothing in this repository mutates a label —
 * there is no update method at all.
 */

import { FeedbackEventSchema, type FeedbackEvent } from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { fromJsonColumn, toRequiredJsonColumn } from '../json.js';
import { BaseRepository, parseEntity, type JsonValue, type Row } from './base.js';

/** The `feedback_events` table. */
export class FeedbackRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts a feedback event. */
  insert(event: FeedbackEvent): FeedbackEvent {
    const entity = parseEntity(FeedbackEventSchema, event, 'FeedbackEvent');

    this.db
      .prepare(
        `INSERT INTO feedback_events (
           id, sample_id, kind, payload_json, created_at, updated_at
         ) VALUES (
           @id, @sample_id, @kind, @payload_json, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        sample_id: entity.sampleId,
        kind: entity.kind,
        payload_json: toRequiredJsonColumn(entity.payloadJson, 'payload_json'),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads a feedback event by id. */
  getById(id: string): FeedbackEvent | undefined {
    const row = this.firstRow('SELECT * FROM feedback_events WHERE id = @id', { id });
    return row ? toFeedbackEvent(row) : undefined;
  }

  /** Every feedback event of one sample, oldest first. */
  listBySample(sampleId: string): FeedbackEvent[] {
    return this.allRows('SELECT * FROM feedback_events WHERE sample_id = @sample_id ORDER BY created_at, id', {
      sample_id: sampleId,
    }).map(toFeedbackEvent);
  }
}

/** Maps a `feedback_events` row to the contract entity. */
export function toFeedbackEvent(row: Row): FeedbackEvent {
  return {
    id: row['id'] as string,
    sampleId: row['sample_id'] as string,
    kind: row['kind'] as FeedbackEvent['kind'],
    payloadJson: fromJsonColumn<JsonValue>(row['payload_json'] as string) as JsonValue,
    createdAt: row['created_at'] as string,
  };
}
