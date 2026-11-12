import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerProgressFrame } from '@vision-lens/contracts';
import {
  launchFixture,
  readLog,
  teardown,
  TEST_BUDGET,
  until,
  waitForPidExit,
} from './helpers.js';

/**
 * The cancellation ladder: cancel frame, grace window, graceful terminate,
 * kill. A cancelled request never resolves with a result.
 */
vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await teardown();
});

const EMBED_REQUEST = {
  operation: 'vision.embed' as const,
  workspaceId: 'ws-test',
  params: { images: ['a.png'], model: 'siglip2-base' },
  budget: { ...TEST_BUDGET },
};

describe('cancellation', () => {
  it('a cancel frame mid-operation stops the request with code CANCELLED and no result', async () => {
    const { client } = await launchFixture('cancel-slow');
    const progressFrames: WorkerProgressFrame[] = [];

    const request = client.request({
      ...EMBED_REQUEST,
      requestId: 'r-cancel',
      onProgress: (frame) => progressFrames.push(frame),
    });
    // Attach the handlers before cancelling: the rejection can arrive while
    // the ladder is still running.
    const settled = request.then(
      () => null,
      (error: unknown) => error,
    );

    // Wait until the operation is running, then cancel it.
    await until(() => progressFrames.length > 0);
    const outcome = await client.cancel('r-cancel');

    expect(outcome).toBe('acknowledged');
    const failure = await settled;
    expect(failure).toMatchObject({
      name: 'WorkerProtocolError',
      code: 'CANCELLED',
      retryable: false,
    });
    // Progress was flowing before the cancellation; no result ever arrived
    // (the promise rejected instead of resolving).
    expect(progressFrames.length).toBeGreaterThan(0);
  });

  it('a worker that ignores the cancel frame is stopped by SIGTERM', async () => {
    const { client, logPath } = await launchFixture(
      'cancel-ignore',
      {},
      { cancelGraceMs: 150, terminateGraceMs: 400 },
    );
    const request = client.request({ ...EMBED_REQUEST, requestId: 'r-ignore' });
    const settled = request.then(
      () => null,
      (error: unknown) => error,
    );

    const outcome = await client.cancel('r-ignore');
    expect(outcome).toBe('terminated');

    const failure = await settled;
    expect(failure).toMatchObject({ name: 'WorkerProtocolError', code: 'CANCELLED' });

    // The cancel frame reached the worker and the host observed the exit.
    expect(readLog(logPath).some((entry) => entry.event === 'cancel-received')).toBe(true);
    expect(client.clientState).toBe('dead');
  });

  it('a worker that ignores SIGTERM too is stopped by SIGKILL', async () => {
    const { client, logPath } = await launchFixture(
      'cancel-ignore',
      { FIXTURE_IGNORE_SIGTERM: '1' },
      { cancelGraceMs: 150, terminateGraceMs: 400 },
    );
    const request = client.request({ ...EMBED_REQUEST, requestId: 'r-kill' });
    const settled = request.then(
      () => null,
      (error: unknown) => error,
    );

    const outcome = await client.cancel('r-kill');
    expect(outcome).toBe('killed');

    const failure = await settled;
    expect(failure).toMatchObject({ code: 'CANCELLED' });

    // The fixture observed the SIGTERM and ignored it, then died to the kill.
    await until(() => readLog(logPath).some((entry) => entry.event === 'sigterm-ignored'));
    const startEntry = readLog(logPath).find((entry) => entry.event === 'start');
    expect(startEntry).toBeDefined();
    const pid = Number(startEntry?.pid);
    expect(await waitForPidExit(pid)).toBe(true);
  });

  it('a cancellation arriving after the result is a no-op and the result stands', async () => {
    const { client } = await launchFixture('happy');
    const outcome = await client.request({ ...EMBED_REQUEST, requestId: 'r-after' });
    expect(outcome.requestId).toBe('r-after');

    const cancellation = await client.cancel('r-after');
    expect(cancellation).toBe('no-op');
    expect(client.clientState).toBe('running');
  });

  it('closing the client stops the worker process', async () => {
    const { client, logPath } = await launchFixture('happy');
    const startEntry = readLog(logPath).find((entry) => entry.event === 'start');
    const pid = Number(startEntry?.pid);

    await client.close();
    expect(client.clientState).toBe('closed');
    expect(await waitForPidExit(pid)).toBe(true);
  });
});
