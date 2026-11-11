import { z } from 'zod';
import {
  EntityIdSchema,
  JsonValueSchema,
  PredictionActorSchema,
  TimestampSchema,
  strict,
} from '../base.js';
import { SurfaceSchema } from '../enums.js';

/**
 * A model-produced label.
 *
 * Constitutional invariants encoded here:
 *  - **Prediction ≠ Annotation (II)**: the actor is restricted to the model
 *    variant, and `modelVersionId` is required — a human label can never be
 *    recorded as a Prediction, and a Prediction payload cannot be parsed as
 *    an Annotation (`ontologyVersionId` is required there and unknown here).
 *  - **Provenance is complete (II, US4)**: a prediction carries the FULL
 *    provenance bundle — actor + surface + session + timestamp — exactly like
 *    an annotation does. `surface` is REQUIRED (a model output always came
 *    through SOME surface) and `sessionId` is optional (a batch inference
 *    run may not have a user session, but it is still recorded when it does).
 *    The store's `predictions` table has `surface` and `session_id` as NOT
 *    NULL columns, so the contract is the first line of defence for both.
 *  - **Calibrated uncertainty over declared confidence (V)**: `probabilityRaw`
 *    is the model's own output and `probabilityCalibrated` the empirically
 *    calibrated probability; the raw value alone is never treated as a
 *    probability.
 *  - **Cost is a first-class metric (VIII)**: `costMicroUsd` and `latencyMs`
 *    travel with the prediction, not in a side table.
 */
export const PredictionSchema = strict({
  id: EntityIdSchema,
  sampleId: EntityIdSchema,
  modelVersionId: EntityIdSchema,
  labelKey: z.string().min(1),
  probabilityRaw: z.number().min(0).max(1),
  probabilityCalibrated: z.number().min(0).max(1).optional(),
  latencyMs: z.number().nonnegative().optional(),
  costMicroUsd: z.number().nonnegative().optional(),
  agreementJson: JsonValueSchema.optional(),
  actor: PredictionActorSchema,
  surface: SurfaceSchema,
  sessionId: z.string().min(1).optional(),
  createdAt: TimestampSchema,
}).describe('A model-produced label.');

export type Prediction = z.infer<typeof PredictionSchema>;
