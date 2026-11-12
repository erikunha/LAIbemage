/**
 * The worker host client: the TypeScript side of the frozen
 * `visionlens.worker.v1` JSONL channel between this orchestration and a
 * worker process.
 */

export { runCancellationLadder, waitFor } from './cancel.js';
export type { CancellationOutcome } from './cancel.js';

export { FrameSizeError, LineDecoder, encodeFrame } from './framing.js';

export {
  assertMajorsCompatible,
  buildHostHello,
  majorOf,
  parseWorkerHello,
} from './handshake.js';
export type { HostHelloInput } from './handshake.js';

export { WorkerDeadlineError, WorkerLaunchError, WorkerProtocolError } from './errors.js';
export type { WorkerFailureKind } from './errors.js';

export { WorkerClient, WORKER_INTERPRETER_ENV, WORKER_SCRIPT_ENV } from './client.js';
export type {
  WorkerClientOptions,
  WorkerClientState,
  WorkerRequestInput,
  WorkerRequestResult,
} from './client.js';
