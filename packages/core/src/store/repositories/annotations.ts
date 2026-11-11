/**
 * Annotations: human- (or agent-) authored ground truth (spec 002, US4).
 *
 * ## Prediction ≠ Annotation (constitution II, FR-002)
 *
 * An annotation is authored by a human or an agent. The contract already
 * refuses a model actor (`AnnotationActorSchema`), and the database refuses
 * it too (`CHECK (actor_kind IN ('human','agent'))`). The two label kinds
 * live in two different tables and can never be confused.
 *
 * ## Provenance is mandatory
 *
 * Every annotation carries who produced it (`actor`), through which surface,
 * in which session and when. The contract makes those fields required and the
 * database makes the corresponding columns NOT NULL. There is no write path
 * that drops provenance.
 *
 * The one field the CONTRACT leaves optional — `sessionId` — is stored in a
 * NOT NULL column with the empty string as the "not recorded" sentinel, and is
 * read back as `undefined` (never as `''`). See the sentinel rule in
 * `./base.ts`.
 *
 * ## Corrections never mutate (constitution II, FR-006, task 3.4)
 *
 * **This repository deliberately exposes no "update label" and no "update
 * provenance" method.** A correction is a NEW annotation row; the row it
 * replaces is marked with `supersededBy` and keeps its actor, surface,
 * session and timestamp forever. That is a constitutional invariant, not a
 * style choice: the audit trail must show what was said, when and by whom —
 * a mutable label destroys exactly that.
 *
 * The single exception is the `supersededBy` pointer itself, which is
 * bookkeeping about the chain and not about the label or its provenance.
 *
 * **The pointer is always set BY THE REPOSITORY, never by the caller.**
 * `insert()` therefore REJECTS a payload that carries a `supersededBy`: the
 * pointer's direction (the OLD row points at its replacement) and its
 * validity are facts about the chain that only the repository can know. A
 * caller-supplied pointer could point at a row of another sample, and would
 * leave the sample with no annotation in force — a silent hole in the ground
 * truth. The chain is written by `correctAnnotation()`, which inserts the
 * replacement and sets the pointer in ONE transaction.
 */

import { AnnotationSchema, type Annotation, type Region } from '@master-vision/contracts';
import type { SqliteDatabase } from '../db.js';
import { nextTimestamp } from '../clock.js';
import { StoreValidationError } from '../errors.js';
import { fromJsonColumn, toJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  sentinelText,
  type Row,
} from './base.js';

/** The `annotations` table. */
export class AnnotationsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * Inserts an annotation.
   *
   * The payload is validated against the contract first: a missing actor, a
   * missing surface or a missing timestamp is rejected before the database
   * is touched.
   *
   * A payload that carries a `supersededBy` pointer is REJECTED: the pointer
   * is set by the repository (see {@link AnnotationsRepository.correctAnnotation}),
   * never by the caller.
   */
  insert(annotation: Annotation): Annotation {
    const entity = parseEntity(AnnotationSchema, annotation, 'Annotation');

    if (entity.supersededBy !== undefined) {
      throw new StoreValidationError(
        'An annotation must not carry a supersededBy pointer: the repository sets it. ' +
          "A correction is a NEW row — use correctAnnotation(originalId, correction) to " +
          'supersede an existing annotation.',
        [],
      );
    }

    this.db
      .prepare(
        `INSERT INTO annotations (
           id, sample_id, ontology_version_id, label_key, geometry_json,
           actor_kind, actor_ref, actor_display_name, actor_agent_run_id,
           surface, session_id, created_at, updated_at, superseded_by
         ) VALUES (
           @id, @sample_id, @ontology_version_id, @label_key, @geometry_json,
           @actor_kind, @actor_ref, @actor_display_name, @actor_agent_run_id,
           @surface, @session_id, @created_at, @updated_at, @superseded_by
         )`,
      )
      .run({
        id: entity.id,
        sample_id: entity.sampleId,
        ontology_version_id: entity.ontologyVersionId,
        label_key: entity.labelKey,
        geometry_json: toJsonColumn(entity.geometry),
        actor_kind: entity.actor.kind,
        actor_ref: entity.actor.ref,
        actor_display_name: nullableText(
          entity.actor.kind === 'human' ? entity.actor.displayName : undefined,
        ),
        actor_agent_run_id: nullableText(
          entity.actor.kind === 'agent' ? entity.actor.agentRunId : undefined,
        ),
        surface: entity.surface,
        // The contract marks `sessionId` optional; the column is NOT NULL and
        // uses the empty string as the "no session recorded" sentinel.
        session_id: sentinelText(entity.sessionId),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
        superseded_by: null,
      });

    return entity;
  }

  /** Reads an annotation by id. */
  getById(id: string): Annotation | undefined {
    const row = this.firstRow('SELECT * FROM annotations WHERE id = @id', { id });
    return row ? toAnnotation(row) : undefined;
  }

  /** Every annotation of one sample, oldest first. */
  listBySample(sampleId: string): Annotation[] {
    return this.allRows(
      'SELECT * FROM annotations WHERE sample_id = @sample_id ORDER BY created_at, id',
      { sample_id: sampleId },
    ).map(toAnnotation);
  }

  /**
   * The full correction chain of a sample, oldest first.
   *
   * Every row that ever carried a label for the sample is returned, including
   * the superseded ones: the history IS the evidence.
   */
  annotationHistory(sampleId: string): Annotation[] {
    return this.listBySample(sampleId);
  }

  /** The annotation currently in force for a sample (the last, unsuperseded one). */
  latestForSample(sampleId: string): Annotation | undefined {
    const row = this.firstRow(
      `SELECT * FROM annotations
        WHERE sample_id = @sample_id AND superseded_by IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      { sample_id: sampleId },
    );
    return row ? toAnnotation(row) : undefined;
  }

  /**
   * Records a correction (spec 002, FR-006 / task 3.4).
   *
   * Inserts `correction` as a NEW annotation row and sets `supersededBy` on
   * the row it replaces. The original row's PROVENANCE — actor, surface,
   * session and its original `createdAt` — is never touched; only the
   * `supersededBy` pointer and `updatedAt` change.
   *
   * Both writes happen in ONE transaction: a chain can never be observed
   * half-written.
   */
  correctAnnotation(originalId: string, correction: Annotation): Annotation {
    const original = this.getById(originalId);
    if (!original) {
      throw new StoreValidationError(
        `Cannot correct annotation '${originalId}': no such annotation.`,
        [],
      );
    }
    if (original.supersededBy !== undefined) {
      throw new StoreValidationError(
        `Cannot correct annotation '${originalId}': it was already superseded by ` +
          `'${original.supersededBy}'. Correct the annotation currently in force instead.`,
        [],
      );
    }

    const entity = parseEntity(AnnotationSchema, correction, 'Annotation');
    if (entity.id === original.id) {
      throw new StoreValidationError(
        'A correction must be a NEW annotation row with its own id.',
        [],
      );
    }
    if (entity.sampleId !== original.sampleId) {
      throw new StoreValidationError(
        `A correction must target the same sample as the annotation it replaces ` +
          `('${original.sampleId}').`,
        [],
      );
    }
    if (entity.supersededBy !== undefined) {
      throw new StoreValidationError(
        'A correction must not carry a supersededBy pointer: the repository sets it.',
        [],
      );
    }

    const stamp = nextTimestamp();
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO annotations (
             id, sample_id, ontology_version_id, label_key, geometry_json,
             actor_kind, actor_ref, actor_display_name, actor_agent_run_id,
             surface, session_id, created_at, updated_at, superseded_by
           ) VALUES (
             @id, @sample_id, @ontology_version_id, @label_key, @geometry_json,
             @actor_kind, @actor_ref, @actor_display_name, @actor_agent_run_id,
             @surface, @session_id, @created_at, @updated_at, NULL
           )`,
        )
        .run({
          id: entity.id,
          sample_id: entity.sampleId,
          ontology_version_id: entity.ontologyVersionId,
          label_key: entity.labelKey,
          geometry_json: toJsonColumn(entity.geometry),
          actor_kind: entity.actor.kind,
          actor_ref: entity.actor.ref,
          actor_display_name: nullableText(
            entity.actor.kind === 'human' ? entity.actor.displayName : undefined,
          ),
          actor_agent_run_id: nullableText(
            entity.actor.kind === 'agent' ? entity.actor.agentRunId : undefined,
          ),
          surface: entity.surface,
          session_id: sentinelText(entity.sessionId),
          created_at: entity.createdAt,
          updated_at: entity.createdAt,
        });

      // The pointer the repository is about to set must point at a row that
      // EXISTS and belongs to the SAME sample. It was just written, so this
      // is the store checking its own invariant rather than the caller's.
      assertSupersedeTarget(this.db, entity.id, original.sampleId);

      // Only the chain pointer and the write stamp change on the old row —
      // its label, actor, surface, session and createdAt are untouched.
      this.db
        .prepare('UPDATE annotations SET superseded_by = @superseded_by, updated_at = @updated_at WHERE id = @id')
        .run({ superseded_by: entity.id, updated_at: stamp, id: original.id });
    });
    write.immediate();

    return entity;
  }
}

/**
 * Validates the target of a supersede pointer.
 *
 * A supersede pointer says "this row was replaced by that one". For the
 * chain to mean anything, the target must EXIST and must belong to the SAME
 * sample — a pointer to a row of another sample would fork the history
 * across two samples and would leave the sample with no annotation in force.
 *
 * The repository is the only writer of that pointer, so this check is the
 * store verifying its own invariant before it writes one.
 */
export function assertSupersedeTarget(
  db: SqliteDatabase,
  targetId: string,
  sampleId: string,
): void {
  const row = db.prepare('SELECT sample_id FROM annotations WHERE id = ?').get(targetId) as
    | { sample_id: string }
    | undefined;
  if (!row) {
    throw new StoreValidationError(
      `Cannot supersede with '${targetId}': no such annotation exists.`,
      [],
    );
  }
  if (row.sample_id !== sampleId) {
    throw new StoreValidationError(
      `Cannot supersede with '${targetId}': it belongs to another sample ` +
        `('${row.sample_id}').`,
      [],
    );
  }
}

/** Maps an `annotations` row to the contract entity. */
export function toAnnotation(row: Row): Annotation {
  const kind = row['actor_kind'] as Annotation['actor']['kind'];
  const actor: Annotation['actor'] =
    kind === 'agent'
      ? {
          kind: 'agent',
          ref: row['actor_ref'] as string,
          ...(optionalText(row['actor_agent_run_id'])
            ? { agentRunId: optionalText(row['actor_agent_run_id']) }
            : {}),
        }
      : {
          kind: 'human',
          ref: row['actor_ref'] as string,
          ...(optionalText(row['actor_display_name'])
            ? { displayName: optionalText(row['actor_display_name']) }
            : {}),
        };

  return {
    id: row['id'] as string,
    sampleId: row['sample_id'] as string,
    ontologyVersionId: row['ontology_version_id'] as string,
    labelKey: row['label_key'] as string,
    geometry: fromJsonColumn<Region>(row['geometry_json'] as string | null),
    actor,
    surface: row['surface'] as Annotation['surface'],
    // The empty string is the "no session recorded" sentinel, not a session:
    // it reads back as absent, never as an empty session id.
    sessionId: optionalText(row['session_id']),
    createdAt: row['created_at'] as string,
    supersededBy: optionalText(row['superseded_by']),
  };
}
