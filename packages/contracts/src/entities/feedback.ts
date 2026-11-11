import { z } from 'zod';
import { EntityIdSchema, JsonValueSchema, TimestampSchema, strict } from '../base.js';
import { FeedbackKindSchema } from '../enums.js';

/**
 * A signal captured about a sample: a human correction, a flag, or a
 * production observation.
 *
 * Feedback is an APPEND-ONLY event, not an edit: a `correction` points at the
 * sample it disputes, and the authoritative new label is a separate
 * `Annotation` row (constitution II, FR-006). Nothing here mutates a label.
 */
export const FeedbackEventSchema = strict({
  id: EntityIdSchema,
  sampleId: EntityIdSchema,
  kind: FeedbackKindSchema,
  payloadJson: JsonValueSchema,
  createdAt: TimestampSchema,
}).describe(
  'A signal captured about a sample: a human correction, a flag, or a production observation.',
);

export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;
