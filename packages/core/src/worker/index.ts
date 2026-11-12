/**
 * The worker host client: the TypeScript side of the frozen
 * `visionlens.worker.v1` JSONL channel between this orchestration and a
 * worker process.
 */

export { runCancellationLadder, waitFor } from './cancel.js';
export type { CancellationOutcome } from './cancel.js';

export {
  encodeFrame,
  FrameSizeError,
  LineDecoder,
  redactSecrets,
  REDACTED,
  WorkerStderrLog,
} from './framing.js';
export type { WorkerLogRecord } from './framing.js';

export {
  assertMajorsCompatible,
  buildHostHello,
  majorOf,
  parseWorkerHello,
} from './handshake.js';
export type { HostHelloInput } from './handshake.js';

export { WorkerDeadlineError, WorkerLaunchError, WorkerProtocolError } from './errors.js';
export type { WorkerFailureKind } from './errors.js';

export {
  isAllowedWorkerInterpreter,
  spawnWorkerProcess,
  WORKER_INTERPRETER_ALLOWLIST,
} from './host.js';
export type { WorkerSpawnInput, WorkerSpawnOptions } from './host.js';

export {
  computeBackoffDelayMs,
  DEFAULT_WORKER_RETRY_POLICY,
  requestWithRetry,
  WorkerClient,
  WORKER_INTERPRETER_ENV,
  WORKER_SCRIPT_ENV,
} from './client.js';
export type {
  WorkerClientOptions,
  WorkerClientState,
  WorkerRequestInput,
  WorkerRequestResult,
  WorkerRetryOptions,
  WorkerRetryPolicy,
} from './client.js';
export type { RetryRandom, RetryReconcile, RetryReconcileContext } from './client.js';
