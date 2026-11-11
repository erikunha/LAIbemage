import { z } from 'zod';
import { EntityIdSchema, JsonValueSchema, TimestampSchema, strict } from '../base.js';

/**
 * A model version made available on a target.
 *
 * `active` marks the deployment currently serving traffic; `pinnedFromId`
 * records the deployment a promotion was pinned from, so a rollback is
 * traceable rather than a mystery.
 */
export const DeploymentSchema = strict({
  id: EntityIdSchema,
  modelVersionId: EntityIdSchema,
  target: z.string().min(1),
  configJson: JsonValueSchema,
  active: z.boolean(),
  promotedAt: TimestampSchema.optional(),
  pinnedFromId: EntityIdSchema.optional(),
  createdAt: TimestampSchema,
}).describe('A model version made available on a target.');

export type Deployment = z.infer<typeof DeploymentSchema>;
