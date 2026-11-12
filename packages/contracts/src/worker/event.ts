import { z } from 'zod';
import { strict } from '../base.js';
import {
  WorkerErrorCodeSchema,
  WorkerProtocolIdSchema,
  WorkerSeqSchema,
} from './protocol.js';

/**
 * The three worker-to-host event envelopes: `progress`, `result` and `error`.
 *
 * `seq` strictly increases per request and starts at 0. Exactly one `result`
 * OR one `error` terminates a request; a cancelled request produces an `error`
 * with code `CANCELLED` and no `result`.
 */

/** The `progress` frame. `completed` never exceeds `total`. */
export const WorkerProgressFrameSchema = strict({
  protocol: WorkerProtocolIdSchema,
  kind: z.literal('progress'),
  requestId: z.string().min(1),
  seq: WorkerSeqSchema,
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})
  .refine((frame) => frame.completed <= frame.total, {
    error: 'progress completed must not exceed total',
  })
  .describe('The progress envelope; completed never exceeds total.');

/** The `result` frame. `result` is free-form and must be stable per operation. */
export const WorkerResultFrameSchema = strict({
  protocol: WorkerProtocolIdSchema,
  kind: z.literal('result'),
  requestId: z.string().min(1),
  seq: WorkerSeqSchema,
  result: z.json(),
}).describe('The result envelope: emitted at most once per requestId.');

/**
 * The `error` frame.
 *
 * `requestId` and `seq` are OPTIONAL here and only here: a response to a line
 * that could not be parsed still carries the request id WHEN the id could be
 * recovered; when it could not, neither id nor seq exists.
 */
export const WorkerErrorFrameSchema = strict({
  protocol: WorkerProtocolIdSchema,
  kind: z.literal('error'),
  /** Absent only when the request id could not be recovered from the line. */
  requestId: z.string().min(1).optional(),
  /** Absent only when the request id could not be recovered from the line. */
  seq: WorkerSeqSchema.optional(),
  code: WorkerErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
}).describe('The error envelope: a typed code, a message and the retryable flag.');

/** Any worker-to-host event frame. */
export const WorkerEventFrameSchema = z.discriminatedUnion('kind', [
  WorkerProgressFrameSchema,
  WorkerResultFrameSchema,
  WorkerErrorFrameSchema,
]);

export type WorkerProgressFrame = z.infer<typeof WorkerProgressFrameSchema>;
export type WorkerResultFrame = z.infer<typeof WorkerResultFrameSchema>;
export type WorkerErrorFrame = z.infer<typeof WorkerErrorFrameSchema>;
export type WorkerEventFrame = z.infer<typeof WorkerEventFrameSchema>;
