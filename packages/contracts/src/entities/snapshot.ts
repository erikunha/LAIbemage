import { z } from 'zod';
import { EntityIdSchema, JsonValueSchema, Sha256Schema, TimestampSchema, strict } from '../base.js';

/**
 * An immutable, content-addressed view of a dataset.
 *
 * Constitutional invariants encoded here:
 *  - **Immutable snapshots**: a snapshot is never edited; a changed split or
 *    a changed manifest produces a NEW snapshot that points at its parent.
 *  - **Reproducibility (I)**: `manifestHash` pins the asset set and
 *    `splitAssignments` pins the split assignment, so any metric can be
 *    traced back to the exact data it was computed on.
 */
export const DatasetSnapshotSchema = strict({
  id: EntityIdSchema,
  manifestHash: Sha256Schema,
  splitAssignments: Sha256Schema,
  ontologyVersionId: EntityIdSchema,
  parentSnapshotId: EntityIdSchema.optional(),
  createdAt: TimestampSchema,
  lineageJson: JsonValueSchema.optional(),
}).describe('An immutable, content-addressed view of a dataset.');

export type DatasetSnapshot = z.infer<typeof DatasetSnapshotSchema>;
