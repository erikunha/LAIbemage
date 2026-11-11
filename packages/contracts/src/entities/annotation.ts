import { z } from 'zod';
import {
  AnnotationActorSchema,
  EntityIdSchema,
  RegionSchema,
  TimestampSchema,
  strict,
} from '../base.js';
import { SurfaceSchema } from '../enums.js';

/**
 * A human- (or agent-) authored ground-truth label.
 *
 * Constitutional invariants encoded here:
 *  - **Prediction ≠ Annotation (II)**: the actor is restricted to human/agent,
 *    and `ontologyVersionId` is required — the same fields a `Prediction`
 *    carries are either absent here or rejected as unknown keys.
 *  - **Corrections never mutate (II, FR-006)**: `supersededBy` is the *only*
 *    correction mechanism. A correction is a NEW annotation row that points
 *    at the one it replaces; the original row keeps its actor, surface,
 *    session and timestamp forever.
 */
export const AnnotationSchema = strict({
  id: EntityIdSchema,
  sampleId: EntityIdSchema,
  ontologyVersionId: EntityIdSchema,
  labelKey: z.string().min(1),
  geometry: RegionSchema.optional(),
  actor: AnnotationActorSchema,
  surface: SurfaceSchema,
  sessionId: z.string().min(1).optional(),
  createdAt: TimestampSchema,
  supersededBy: EntityIdSchema.optional(),
}).describe('A human- (or agent-) authored ground-truth label.');

export type Annotation = z.infer<typeof AnnotationSchema>;
