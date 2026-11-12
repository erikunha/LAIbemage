import { z } from 'zod';
import { strict } from '../base.js';
import { WorkerProtocolIdSchema } from './protocol.js';

/**
 * The `cancel` envelope (host to worker).
 *
 * Cancellation is best effort: the host asks the worker to stop the operation
 * named by `requestId`, then escalates through a graceful terminate to a kill.
 * A cancelled request produces an `error` with code `CANCELLED` and no result.
 */
export const WorkerCancelFrameSchema = strict({
  protocol: WorkerProtocolIdSchema,
  kind: z.literal('cancel'),
  requestId: z.string().min(1),
}).describe('The cancel envelope: stop the operation named by requestId.');

export type WorkerCancelFrame = z.infer<typeof WorkerCancelFrameSchema>;
