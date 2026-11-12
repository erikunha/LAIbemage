import { describe, expect, it } from 'vitest';
import type { WorkerRequestInput, WorkerRequestResult } from '../../src/worker/index.js';
import {
  computeBackoffDelayMs,
  DEFAULT_WORKER_RETRY_POLICY,
  requestWithRetry,
} from '../../src/worker/client.js';
import {
  WorkerDeadlineError,
  WorkerLaunchError,
  WorkerProtocolError,
} from '../../src/worker/errors.js';

/**
 * Task 2.6 (FR-011): bounded backoff with jitter for transient provider/IO
 * failures, no retry for deterministic invalid input, and never a blind
 * retry of a non-idempotent external action without reconciliation.
 *
 * The retryable classification is the FROZEN flag table of the wire
 * vocabulary (`WORKER_ERROR_RETRYABLE`), so these tests stub the client and
 * drive the policy alone; the flag table itself is pinned by the contracts
 * suites.
 */

/** A stub client whose request fails N times before succeeding. */
function stubClient(script: Array<Error | WorkerRequestResult>) {
  const calls: string[] = [];
  let cursor = 0;
  const client = {
    async request(input: WorkerRequestInput): Promise<WorkerRequestResult> {
      calls.push(input.requestId ?? '(generated)');
      const step = script[Math.min(cursor, script.length - 1)]!;
      cursor += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { client, calls };
}

const INPUT: WorkerRequestInput = {
  requestId: 'r-retry',
  operation: 'vision.embed',
  workspaceId: 'ws-test',
  params: {},
  budget: { maxSeconds: 30, maxUsdMicro: 0 },
};

const SUCCESS: WorkerRequestResult = { requestId: 'r-retry', seq: 1, result: { ok: true } };

const ZERO_DELAY = { ...DEFAULT_WORKER_RETRY_POLICY, baseDelayMs: 0, maxDelayMs: 0 };

describe('computeBackoffDelayMs', () => {
  it('grows exponentially and is capped by maxDelayMs', () => {
    const policy = { ...DEFAULT_WORKER_RETRY_POLICY, baseDelayMs: 100, maxDelayMs: 1000 };
    // Deterministic rng: full jitter scales the exponential cap.
    expect(computeBackoffDelayMs(1, policy, () => 0.5)).toBe(50);
    expect(computeBackoffDelayMs(2, policy, () => 0.5)).toBe(100);
    expect(computeBackoffDelayMs(3, policy, () => 0.5)).toBe(200);
    expect(computeBackoffDelayMs(4, policy, () => 0.5)).toBe(400);
    // The cap holds even for deep attempts.
    expect(computeBackoffDelayMs(20, policy, () => 1)).toBe(1000);
  });

  it('jitter keeps the delay inside [0, cap] for the attempt', () => {
    const policy = { ...DEFAULT_WORKER_RETRY_POLICY, baseDelayMs: 100, maxDelayMs: 10_000 };
    for (const roll of [0, 0.25, 0.9, 1]) {
      const delay = computeBackoffDelayMs(2, policy, () => roll);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(200);
    }
  });
});

describe('requestWithRetry', () => {
  it('retries a transient provider failure and succeeds on the second attempt', async () => {
    const { client, calls } = stubClient([
      new WorkerProtocolError('PROVIDER_UNAVAILABLE', 'provider is down'),
      SUCCESS,
    ]);

    const outcome = await requestWithRetry(client, INPUT, { policy: ZERO_DELAY });

    expect(outcome).toEqual(SUCCESS);
    // The SECOND attempt is a NEW requestId, never the terminated first one.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('r-retry');
    expect(calls[1]).not.toBe('r-retry');
    expect(calls[1]).toContain('r-retry');
  });

  it('retries a worker death when the caller declares the operation idempotent', async () => {
    const { client, calls } = stubClient([
      new WorkerLaunchError('worker-died', 'the worker exited mid-request'),
      SUCCESS,
    ]);
    const outcome = await requestWithRetry(client, INPUT, {
      policy: ZERO_DELAY,
      // A worker death leaves the external effects unknown; only a caller
      // who knows the operation left no external state may retry it.
      idempotent: true,
    });
    expect(outcome).toEqual(SUCCESS);
    expect(calls).toHaveLength(2);
  });

  it('a worker death with unknown effects is NOT blind-retried', async () => {
    const { client, calls } = stubClient([
      new WorkerLaunchError('worker-died', 'the worker exited mid-request'),
      SUCCESS,
    ]);
    await expect(requestWithRetry(client, INPUT, { policy: ZERO_DELAY })).rejects.toBeInstanceOf(
      WorkerLaunchError,
    );
    expect(calls).toHaveLength(1);
  });

  it('gives up after the bounded number of attempts', async () => {
    const { client, calls } = stubClient([
      new WorkerProtocolError('PROVIDER_UNAVAILABLE', 'still down'),
    ]);

    await expect(
      requestWithRetry(client, INPUT, {
        policy: { ...ZERO_DELAY, maxAttempts: 3 },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(calls).toHaveLength(3);
  });

  it('does NOT retry deterministic invalid input', async () => {
    for (const deterministic of [
      new WorkerProtocolError('MALFORMED_FRAME', 'bad frame'),
      new WorkerProtocolError('UNSUPPORTED_OPERATION', 'no such op'),
      new WorkerProtocolError('BUDGET_EXCEEDED', 'no budget'),
      new WorkerDeadlineError('r-retry', 30),
    ]) {
      const { client, calls } = stubClient([deterministic]);
      await expect(
        requestWithRetry(client, INPUT, { policy: ZERO_DELAY }),
      ).rejects.toBe(deterministic);
      expect(calls).toHaveLength(1);
    }
  });

  it('never blind-retries a non-idempotent request without reconciliation', async () => {
    const { client, calls } = stubClient([
      new WorkerProtocolError('WORKER_CRASHED', 'died after the external action'),
    ]);

    await expect(
      requestWithRetry(client, INPUT, {
        policy: ZERO_DELAY,
        // No idempotency claim, no reconciliation: the default is unknown,
        // and unknown is treated as NON-idempotent.
      }),
    ).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    expect(calls).toHaveLength(1);
  });

  it('a non-idempotent request IS retried when reconciliation proves no effect', async () => {
    const { client, calls } = stubClient([
      new WorkerProtocolError('WORKER_CRASHED', 'died before the effect'),
      SUCCESS,
    ]);
    const reconciled: string[] = [];

    const outcome = await requestWithRetry(client, INPUT, {
      policy: ZERO_DELAY,
      reconcile: async (context) => {
        reconciled.push(`${context.attempt}:${context.requestId}`);
        return true; // the failed attempt provably had no external effect
      },
    });

    expect(outcome).toEqual(SUCCESS);
    expect(calls).toHaveLength(2);
    expect(reconciled).toEqual([`1:${calls[0]}`]);
  });

  it('a reconciliation that finds an effect stops the retry', async () => {
    const { client, calls } = stubClient([
      new WorkerProtocolError('WORKER_CRASHED', 'died AFTER the effect'),
      SUCCESS,
    ]);

    await expect(
      requestWithRetry(client, INPUT, {
        policy: ZERO_DELAY,
        reconcile: () => false, // the external action DID happen
      }),
    ).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    expect(calls).toHaveLength(1);
  });

  it('an explicitly idempotent request is retried without reconciliation', async () => {
    const { client, calls } = stubClient([
      new WorkerProtocolError('WORKER_CRASHED', 'transient'),
      SUCCESS,
    ]);
    const outcome = await requestWithRetry(client, INPUT, {
      policy: ZERO_DELAY,
      idempotent: true,
    });
    expect(outcome).toEqual(SUCCESS);
    expect(calls).toHaveLength(2);
  });
});
