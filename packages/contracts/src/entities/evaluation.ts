import { z } from 'zod';
import { EntityIdSchema, JsonValueSchema, TimestampSchema, strict } from '../base.js';

/**
 * The measured evaluation of one experiment under a named protocol.
 *
 * Constitutional invariant (I): a metric without its reproduction record is a
 * hypothesis, not a result — `experimentRunId` points at the run that carries
 * the config fingerprint and the input snapshot, so the protocol, the data and
 * the configuration stay joined to the number.
 */
export const EvaluationRunSchema = strict({
  id: EntityIdSchema,
  experimentRunId: EntityIdSchema,
  protocol: z.string().min(1),
  resultsJson: JsonValueSchema,
  reportPath: z.string().min(1).optional(),
  createdAt: TimestampSchema,
}).describe('The measured evaluation of one experiment under a named protocol.');

export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;
