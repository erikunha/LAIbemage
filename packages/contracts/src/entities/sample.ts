import { z } from 'zod';
import { EntityIdSchema, RegionSchema, TimestampSchema, strict } from '../base.js';
import { SplitKindSchema } from '../enums.js';

/**
 * A labelled unit of observation: one asset, optionally one region of it.
 *
 * `snapshotIds` records which immutable dataset snapshots contain this sample
 * — it defaults to `[]` because a sample exists before it is ever snapshotted.
 * The ids are UUIDv7 entity ids: a snapshot id that cannot be resolved would
 * make the membership claim meaningless, so the lineage rule applies here too.
 * `split` is a convenience mirror of the authoritative assignment kept in
 * `DatasetSnapshot.splitAssignments` (snapshots are immutable, so a re-split
 * produces a new snapshot rather than mutating this field).
 */
export const SampleSchema = strict({
  id: EntityIdSchema,
  assetId: EntityIdSchema,
  region: RegionSchema.optional(),
  split: SplitKindSchema.optional(),
  snapshotIds: z.array(EntityIdSchema).default([]),
  sourceCaptureFrame: z.string().min(1).optional(),
  createdAt: TimestampSchema,
}).describe('A labelled unit of observation: one asset, optionally one region of it.');

export type Sample = z.infer<typeof SampleSchema>;
