/**
 * The ratified `visionlens.worker.v1` wire protocol (the JSONL worker channel).
 *
 * Six frame kinds: `hello`, `request`, `progress`, `result`, `error`, `cancel`.
 * Every frame is a STRICT object: an unknown field is a malformed frame, never
 * a stripped field.
 */

export {
  DEFAULT_MAX_FRAME_BYTES,
  WORKER_ERROR_CODES,
  WORKER_ERROR_RETRYABLE,
  WORKER_OPERATIONS,
  WORKER_PROTOCOL_ID,
  WORKER_PROTOCOL_MAJOR,
  WORKER_PROTOCOL_VERSION,
  WorkerErrorCodeSchema,
  WorkerOperationSchema,
  WorkerProtocolIdSchema,
  WorkerRequestIdSchema,
  WorkerSemverSchema,
  WorkerSeqSchema,
} from './protocol.js';
export type { WorkerErrorCode, WorkerOperation } from './protocol.js';

export { HostHelloFrameSchema, WorkerCapabilitiesSchema, WorkerHelloFrameSchema } from './hello.js';
export type { HostHelloFrame, WorkerCapabilities, WorkerHelloFrame } from './hello.js';

export { WorkerBudgetSchema, WorkerRequestFrameSchema } from './request.js';
export type { WorkerBudget, WorkerRequestFrame } from './request.js';

export {
  WorkerErrorFrameSchema,
  WorkerEventFrameSchema,
  WorkerProgressFrameSchema,
  WorkerResultFrameSchema,
} from './event.js';
export type {
  WorkerErrorFrame,
  WorkerEventFrame,
  WorkerProgressFrame,
  WorkerResultFrame,
} from './event.js';

export { WorkerCancelFrameSchema } from './cancel.js';
export type { WorkerCancelFrame } from './cancel.js';

import { z } from 'zod';
import { WorkerCancelFrameSchema } from './cancel.js';
import {
  WorkerErrorFrameSchema,
  WorkerProgressFrameSchema,
  WorkerResultFrameSchema,
} from './event.js';
import { WorkerHelloFrameSchema } from './hello.js';
import { WorkerRequestFrameSchema } from './request.js';
import { WorkerErrorCodeSchema, WorkerOperationSchema } from './protocol.js';

/** The union of all six frame kinds, discriminated by `kind`. */
export const WorkerFrameSchema = z.discriminatedUnion('kind', [
  WorkerHelloFrameSchema,
  WorkerRequestFrameSchema,
  WorkerProgressFrameSchema,
  WorkerResultFrameSchema,
  WorkerErrorFrameSchema,
  WorkerCancelFrameSchema,
]);

export type WorkerFrame = z.infer<typeof WorkerFrameSchema>;

/**
 * Every worker frame schema, keyed by its public name.
 *
 * Consumed by the contract manifest generator (`src/manifest.ts`) so the
 * breaking-change guard covers the wire protocol: a removed or reshaped frame
 * field is a breaking change and requires a MAJOR `CONTRACTS_VERSION` bump.
 */
export const WORKER_FRAME_SCHEMAS = {
  WorkerHelloFrame: WorkerHelloFrameSchema,
  WorkerRequestFrame: WorkerRequestFrameSchema,
  WorkerProgressFrame: WorkerProgressFrameSchema,
  WorkerResultFrame: WorkerResultFrameSchema,
  WorkerErrorFrame: WorkerErrorFrameSchema,
  WorkerCancelFrame: WorkerCancelFrameSchema,
} as const;

export type WorkerFrameName = keyof typeof WORKER_FRAME_SCHEMAS;

/**
 * The worker protocol's enums, merged into the manifest's `enums` section so a
 * removed operation code or error code is detected as breaking.
 */
export const WORKER_ENUM_SCHEMAS = {
  WorkerOperation: WorkerOperationSchema,
  WorkerErrorCode: WorkerErrorCodeSchema,
} as const;
