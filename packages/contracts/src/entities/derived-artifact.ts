import { z } from 'zod';
import { EntityIdSchema, FingerprintSchema, TimestampSchema, strict } from '../base.js';

/** The kinds of artifact derived from one or more assets. */
export const DERIVED_ARTIFACT_KINDS = ['thumbnail', 'embedding', 'report', 'mask', 'crop'] as const;

/**
 * An artifact derived from original assets (thumbnail, embedding, report,
 * mask, crop).
 *
 * Constitutional invariants encoded here (II, US4, FR-006):
 *  - **Lineage is structural, not conventional**: `sourceAssetIds` is
 *    REQUIRED and non-empty, `transform` and `transformFingerprint` are
 *    REQUIRED. A derived artifact without lineage cannot be constructed, so
 *    "which encoder and which snapshot produced this embedding" always has an
 *    answer.
 *  - **Lineage ids are REAL ids**: `sourceAssetIds` holds UUIDv7 entity ids,
 *    the identity format of the domain model. A free-form string would make
 *    the lineage walk unresolvable — the artifact would point at something
 *    that cannot be fetched.
 *  - **Originals are immutable**: a derived artifact never replaces its
 *    source; it points at it.
 */
export const DerivedArtifactSchema = strict({
  id: EntityIdSchema,
  kind: z.enum(DERIVED_ARTIFACT_KINDS),
  sourceAssetIds: z.array(EntityIdSchema).min(1),
  sourceSnapshotId: EntityIdSchema.optional(),
  transform: z.string().min(1),
  transformFingerprint: FingerprintSchema,
  createdAt: TimestampSchema,
}).describe('An artifact derived from original assets (thumbnail, embedding, report, mask, crop).');

export type DerivedArtifact = z.infer<typeof DerivedArtifactSchema>;
export type DerivedArtifactKind = (typeof DERIVED_ARTIFACT_KINDS)[number];
