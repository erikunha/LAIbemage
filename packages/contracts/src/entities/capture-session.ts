import { z } from 'zod';
import { EntityIdSchema, JsonValueSchema, TimestampSchema, strict } from '../base.js';

/**
 * A capture session: one device/camera producing a stream of frames.
 *
 * `source` is the camera or device label (e.g. `line-a/cam-03`); `contextJson`
 * carries whatever else the surface knew at capture time (exposure settings,
 * operator, calibration reference).
 */
export const CaptureSessionSchema = strict({
  id: EntityIdSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  source: z.string().min(1),
  contextJson: JsonValueSchema.optional(),
}).describe('A capture session: one device/camera producing a stream of frames.');

export type CaptureSession = z.infer<typeof CaptureSessionSchema>;
