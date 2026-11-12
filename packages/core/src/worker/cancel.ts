import type { ChildProcess } from 'node:child_process';

/**
 * The cancellation ladder: cancel frame, then a grace window, then a graceful
 * terminate (SIGTERM), then a kill (SIGKILL).
 *
 * Cancellation is best effort. The host first asks the worker to stop by
 * `requestId`; a worker that acknowledges produces an `error` frame with code
 * `CANCELLED` and no result. A worker that ignores the frame is stopped by
 * SIGTERM, and one that ignores SIGTERM too is stopped by SIGKILL.
 */

/** Outcome of one walk down the ladder. */
export type CancellationOutcome =
  /** The worker acknowledged the cancel frame inside the grace window. */
  | 'acknowledged'
  /** The request was already terminal, so the cancellation is a recorded no-op. */
  | 'no-op'
  /** The worker ignored the cancel frame and was stopped by SIGTERM. */
  | 'terminated'
  /** The worker ignored SIGTERM too and was stopped by SIGKILL. */
  | 'killed';

/** Resolves true once `condition` holds, false when `ms` elapse first. */
export function waitFor(condition: () => boolean, ms: number, tickMs = 10): Promise<boolean> {
  return new Promise((resolve) => {
    if (condition()) {
      resolve(true);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - startedAt >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, tickMs);
  });
}

export interface CancellationLadderInput {
  child: ChildProcess;
  /** True once the worker acknowledged the cancellation (a CANCELLED error frame). */
  isAcknowledged: () => boolean;
  /** True once the child process has exited. */
  hasExited: () => boolean;
  /** Grace window for the cancel acknowledgement, in milliseconds. */
  graceMs: number;
  /** Grace window after SIGTERM before SIGKILL, in milliseconds. */
  terminateMs: number;
  /** Waits for the child's exit event (resolves even if it already fired). */
  waitForExit: () => Promise<void>;
}

/**
 * Walks the escalation ladder AFTER the cancel frame has been written.
 *
 * The caller sends the cancel frame, then calls this. Each stage is observable
 * through the returned outcome so a caller can record how the stop actually
 * happened.
 */
export async function runCancellationLadder(
  input: CancellationLadderInput,
): Promise<CancellationOutcome> {
  const { child, isAcknowledged, hasExited, graceMs, terminateMs, waitForExit } = input;

  await waitFor(() => isAcknowledged() || hasExited(), graceMs);
  if (isAcknowledged()) return 'acknowledged';
  if (hasExited()) {
    await waitForExit().catch(() => undefined);
    return 'terminated';
  }

  child.kill('SIGTERM');
  const terminated = await waitFor(hasExited, terminateMs);
  if (terminated) {
    await waitForExit().catch(() => undefined);
    return 'terminated';
  }

  child.kill('SIGKILL');
  await waitForExit().catch(() => undefined);
  return 'killed';
}
