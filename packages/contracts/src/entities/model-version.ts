import { z } from 'zod';
import { EntityIdSchema, JsonValueSchema, TimestampSchema, strict } from '../base.js';
import { RegistryStateSchema } from '../enums.js';

/**
 * A versioned model in the registry.
 *
 * Constitutional invariants encoded here:
 *  - **Provenance of a prediction (II)**: a `Prediction.modelVersionId`
 *    points here, so any model output resolves to the exact artifact,
 *    recipe and calibration that produced it.
 *  - **Lifecycle is explicit**: `registryState` distinguishes a draft from a
 *    candidate, a registered model, a deprecated one and a legacy import.
 */
export const ModelVersionSchema = strict({
  id: EntityIdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  registryState: RegistryStateSchema,
  recipe: JsonValueSchema.optional(),
  artifactPath: z.string().min(1).optional(),
  calibrationRef: z.string().min(1).optional(),
  modelCardPath: z.string().min(1).optional(),
  createdAt: TimestampSchema,
}).describe('A versioned model in the registry.');

export type ModelVersion = z.infer<typeof ModelVersionSchema>;
