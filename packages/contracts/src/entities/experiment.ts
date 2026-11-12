import { z } from 'zod';
import {
  EntityIdSchema,
  FingerprintSchema,
  JsonValueSchema,
  TimestampSchema,
  strict,
} from '../base.js';
import { JobStateSchema, RunKindSchema } from '../enums.js';

/**
 * One run of the pipeline (classify / train / eval / arena / al / agent).
 *
 * Constitutional invariants encoded here:
 *  - **Reproducibility (I)**: `configFingerprint` is the FULL semantic
 *    configuration fingerprint (model, prompt, taxonomy with descriptions,
 *    preprocessing, data version) — not a name-only hash. It is pinned to the
 *    `fp2:<16 hex>` shape `fingerprintV2` produces, so a run can never claim
 *    to be reproducible against a key that is not a real fingerprint.
 *  - **Every pipeline admits abstention (V)**: `status` includes `abstained`
 *    next to `succeeded`/`failed`, so an uncertain run is recorded rather
 *    than silently reported as a success.
 */
export const ExperimentRunSchema = strict({
  id: EntityIdSchema,
  kind: RunKindSchema,
  inputSnapshotId: EntityIdSchema.optional(),
  configFingerprint: FingerprintSchema,
  status: JobStateSchema,
  metricsSummaryJson: JsonValueSchema.optional(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
}).describe('One run of the pipeline (classify / train / eval / arena / al / agent).');

export type ExperimentRun = z.infer<typeof ExperimentRunSchema>;
