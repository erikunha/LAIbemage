import type { WorkerErrorCode } from '@vision-lens/contracts';
import { WORKER_ERROR_RETRYABLE } from '@vision-lens/contracts';

/**
 * Typed failures of the worker host client.
 *
 * Two classes are kept strictly apart because they mean different things to a
 * caller that decides whether to retry:
 *
 *  - {@link WorkerLaunchError}: the worker PROCESS could not be used. Spawn
 *    error, handshake timeout, worker died. Nothing the worker said was wrong;
 *    the channel itself failed.
 *  - {@link WorkerProtocolError}: the worker SAID something the frozen
 *    `visionlens.worker.v1` wire contract forbids, or answered with a
 *    code-bearing error frame. Carries the frozen vocabulary code and its
 *    retryable flag.
 *
 * {@link WorkerDeadlineError} is the host-side enforcement of
 * `budget.maxSeconds`: the request ran out of wall clock before the worker
 * finished, and the host stopped it through the cancellation ladder.
 */

/** Why a launch (or a running channel) failed at the process level. */
export type WorkerFailureKind = 'spawn-error' | 'handshake-timeout' | 'worker-died';

/** The worker process itself failed: spawn error, handshake timeout, or death. */
export class WorkerLaunchError extends Error {
  readonly kind: WorkerFailureKind;
  /** Only a worker death is a candidate for a bounded retry. */
  readonly retryable: boolean;

  constructor(kind: WorkerFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkerLaunchError';
    this.kind = kind;
    this.retryable = kind === 'worker-died';
  }
}

/** A wire-protocol violation or a code-bearing error frame from the worker. */
export class WorkerProtocolError extends Error {
  readonly code: WorkerErrorCode;
  /** Human-readable statement of WHICH rule was violated. */
  readonly violation: string;
  /** The frozen retryable flag of the code. */
  readonly retryable: boolean;

  constructor(code: WorkerErrorCode, violation: string, message?: string) {
    super(message ?? `${code}: ${violation}`);
    this.name = 'WorkerProtocolError';
    this.code = code;
    this.violation = violation;
    this.retryable = WORKER_ERROR_RETRYABLE[code];
  }
}

/** `budget.maxSeconds` elapsed before the worker answered the request. */
export class WorkerDeadlineError extends Error {
  readonly code = 'DEADLINE_EXCEEDED';
  readonly retryable = false;
  readonly requestId: string;
  readonly maxSeconds: number;

  constructor(requestId: string, maxSeconds: number) {
    super(
      `DEADLINE_EXCEEDED: budget.maxSeconds of ${maxSeconds} elapsed for request ${requestId}`,
    );
    this.name = 'WorkerDeadlineError';
    this.requestId = requestId;
    this.maxSeconds = maxSeconds;
  }
}
