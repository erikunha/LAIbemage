import { z } from 'zod';

/**
 * Frozen vocabulary of the `visionlens.worker.v1` wire protocol.
 *
 * Authority: `docs/vnext/contracts/proposed/worker-request.v1.schema.json` and
 * `worker-event.v1.schema.json` (the pack proposals) as narrowed by the frozen
 * wire contract. Every constant here is part of the guarded contract surface:
 * changing one is a breaking change and requires a MAJOR `CONTRACTS_VERSION`
 * bump (see `src/version-guard.ts`).
 */

/**
 * The protocol identity string carried by every frame.
 *
 * The major lives INSIDE the constant: a protocol major change is a different
 * protocol id and a handshake refusal, not a version bump.
 */
export const WORKER_PROTOCOL_ID = 'visionlens.worker.v1';

/** The protocol major encoded in {@link WORKER_PROTOCOL_ID}. */
export const WORKER_PROTOCOL_MAJOR = 1;

/** The protocol version this package speaks (independent of the contract version). */
export const WORKER_PROTOCOL_VERSION = '1.0.0';

/**
 * Default maximum frame size: 1 MiB, negotiable in the handshake through
 * `maxFrameBytes`.
 */
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

/** Literal schema for the protocol identity string. */
export const WorkerProtocolIdSchema = z
  .literal(WORKER_PROTOCOL_ID)
  .describe('The protocol identity string, fixed at "visionlens.worker.v1".');

/**
 * A semantic version `major.minor.patch`, as carried by `protocolVersion` and
 * `contractVersion`.
 */
export const WorkerSemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, {
    error: 'Expected a semantic version of the form major.minor.patch.',
  })
  .describe('A semantic version of the form major.minor.patch.');

/**
 * Request identifier: 1 to 128 characters. The host owns the namespace; a
 * reused id is a correlation violation.
 */
export const WorkerRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .describe('Request identifier: 1 to 128 characters, unique among requests.');

/**
 * The five operation codes the v1 wire accepts. The three catalog codes the
 * pack lists but the proposal omits (`dataset.inspect`, `annotation.propose`,
 * `model.promote`) MUST NOT be accepted in v1.
 */
export const WORKER_OPERATIONS = [
  'vision.embed',
  'vision.predict',
  'dataset.audit',
  'eval.run',
  'model.train',
] as const;

export type WorkerOperation = (typeof WORKER_OPERATIONS)[number];

export const WorkerOperationSchema = z
  .enum(WORKER_OPERATIONS)
  .describe('One of the five v1 operation codes.');

/**
 * The frozen error-code vocabulary with its retryable flags.
 *
 * Deterministic invalid input is never retried; the two transient codes are
 * retried with bounded backoff and jitter.
 */
export const WORKER_ERROR_CODES = [
  'UNSUPPORTED_PROTOCOL',
  'MISSING_EXTRA',
  'MALFORMED_FRAME',
  'PROTOCOL_MISMATCH',
  'UNSUPPORTED_OPERATION',
  'CANCELLED',
  'DEADLINE_EXCEEDED',
  'BUDGET_EXCEEDED',
  'WORKER_CRASHED',
  'PROVIDER_UNAVAILABLE',
] as const;

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

export const WorkerErrorCodeSchema = z
  .enum(WORKER_ERROR_CODES)
  .describe('One of the ten frozen worker error codes.');

/**
 * The retryable flag of every error code, frozen with the vocabulary itself so
 * a consumer never has to guess whether a code may be retried.
 */
export const WORKER_ERROR_RETRYABLE = {
  UNSUPPORTED_PROTOCOL: false,
  MISSING_EXTRA: false,
  MALFORMED_FRAME: false,
  PROTOCOL_MISMATCH: false,
  UNSUPPORTED_OPERATION: false,
  CANCELLED: false,
  DEADLINE_EXCEEDED: false,
  BUDGET_EXCEEDED: false,
  WORKER_CRASHED: true,
  PROVIDER_UNAVAILABLE: true,
} as const satisfies Record<WorkerErrorCode, boolean>;

/** Non-negative integer sequence number of a worker-to-host frame. */
export const WorkerSeqSchema = z
  .number()
  .int()
  .nonnegative()
  .describe('Sequence number of a frame: strictly increasing per request, starting at 0.');
