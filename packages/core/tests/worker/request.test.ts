import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerProgressFrame } from '@vision-lens/contracts';
import {
  WorkerDeadlineError,
  WorkerLaunchError,
  WorkerProtocolError,
} from '../../src/worker/index.js';
import {
  launchFixture,
  readLog,
  teardown,
  TEST_BUDGET,
  until,
} from './helpers.js';

/**
 * Request behaviour: correlation by requestId, seq monotonicity, progress
 * surfacing, deadline enforcement, frame-size limits and contamination
 * handling on the worker-to-host channel.
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

describe('request correlation', () => {
  it('resolves with the result and surfaces progress frames in order', async () => {
    const { client } = await launchFixture('happy');
    const progressFrames: WorkerProgressFrame[] = [];

    const outcome = await client.request({
      ...EMBED_REQUEST,
      requestId: 'r-happy',
      onProgress: (frame) => progressFrames.push(frame),
    });

    expect(outcome.requestId).toBe('r-happy');
    expect(outcome.seq).toBe(2);
    expect(outcome.result).toEqual({
      operation: 'vision.embed',
      params: EMBED_REQUEST.params,
      echoed: true,
    });
    expect(progressFrames.map((frame) => frame.seq)).toEqual([0, 1]);
    expect(progressFrames.map((frame) => frame.completed)).toEqual([1, 2]);
    expect(progressFrames.every((frame) => frame.requestId === 'r-happy')).toBe(true);
  });

  it('five concurrent requests are each attributed to their own requestId', async () => {
    const { client } = await launchFixture('happy');
    const seen: WorkerProgressFrame[] = [];

    const outcomes = await Promise.all(
      ['r-a', 'r-b', 'r-c', 'r-d', 'r-e'].map((requestId) =>
        client.request({
          ...EMBED_REQUEST,
          requestId,
          params: { ...EMBED_REQUEST.params, images: [`${requestId}.png`] },
          onProgress: (frame) => seen.push(frame),
        }),
      ),
    );

    expect(outcomes.map((outcome) => outcome.requestId).sort()).toEqual([
      'r-a',
      'r-b',
      'r-c',
      'r-d',
      'r-e',
    ]);
    for (const outcome of outcomes) {
      const params = outcome.result as { params: { images: string[] } };
      expect(params.params.images).toEqual([`${outcome.requestId}.png`]);
      // Every request saw its own progress frames only, with rising seq.
      const own = seen.filter((frame) => frame.requestId === outcome.requestId);
      expect(own.map((frame) => frame.seq)).toEqual([0, 1]);
    }
  });

  it('refuses an operation the worker did not advertise, before writing it', async () => {
    const { client, logPath } = await launchFixture('happy');

    await expect(client.request({ ...EMBED_REQUEST, operation: 'vision.predict' })).rejects.toMatchObject(
      {
        name: 'WorkerProtocolError',
        code: 'UNSUPPORTED_OPERATION',
        retryable: false,
      },
    );

    // The fixture never saw the request: only the host hello is on its stdin.
    await until(() => readLog(logPath).some((entry) => entry.event === 'stdin'));
    const requests = readLog(logPath).filter((entry) => {
      if (entry.event !== 'stdin') return false;
      const frame = JSON.parse(String(entry.line)) as { kind?: string };
      return frame.kind === 'request';
    });
    expect(requests).toEqual([]);
  });

  it('refuses to reuse a requestId that is already in flight', async () => {
    const { client } = await launchFixture('hang');
    const first = client.request({ ...EMBED_REQUEST, requestId: 'r-dup' });
    const firstSettled = first.then(
      () => null,
      (error: unknown) => error,
    );
    await expect(client.request({ ...EMBED_REQUEST, requestId: 'r-dup' })).rejects.toThrow(
      /already in flight/,
    );
    await client.cancel('r-dup');
    await expect(firstSettled).resolves.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('sequence monotonicity', () => {
  it('a seq that does not advance fails the request as a protocol violation', async () => {
    const { client } = await launchFixture('bad-seq');
    await expect(client.request(EMBED_REQUEST)).rejects.toMatchObject({
      name: 'WorkerProtocolError',
      code: 'MALFORMED_FRAME',
      violation: expect.stringContaining('strictly increase'),
    });
    // The channel itself stays usable for other requests.
    expect(client.clientState).toBe('running');
  });

  it('a first frame whose seq is not 0 fails the request', async () => {
    const { client } = await launchFixture('seq-not-zero');
    await expect(client.request(EMBED_REQUEST)).rejects.toMatchObject({
      name: 'WorkerProtocolError',
      code: 'MALFORMED_FRAME',
      violation: expect.stringContaining('not 0'),
    });
  });

  it('a duplicate result keeps the first outcome and reports the second', async () => {
    const violations: string[] = [];
    const { client } = await launchFixture('duplicate-result', {}, { onViolation: (v) => violations.push(v) });

    const outcome = await client.request({ ...EMBED_REQUEST, requestId: 'r-dup-result' });
    expect(outcome.result).toEqual({ value: 'first' });

    await until(() => violations.length > 0);
    expect(violations[0]).toContain('arrived after the request terminated');
    expect(client.clientState).toBe('running');
  });
});

describe('deadline enforcement', () => {
  it('budget.maxSeconds elapsing fails the request with a typed deadline error', async () => {
    const { client } = await launchFixture('hang', {}, { cancelGraceMs: 120, terminateGraceMs: 300 });

    const failure = await client
      .request({ ...EMBED_REQUEST, requestId: 'r-deadline', budget: { maxSeconds: 1, maxUsdMicro: 0 } })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(WorkerDeadlineError);
    expect(failure).not.toBeInstanceOf(WorkerProtocolError);
    const deadline = failure as WorkerDeadlineError;
    expect(deadline.code).toBe('DEADLINE_EXCEEDED');
    expect(deadline.retryable).toBe(false);
    expect(deadline.maxSeconds).toBe(1);

    // The host stopped the worker through the cancellation ladder.
    await until(() => client.clientState === 'dead');
  });
});

describe('frame contamination from the worker', () => {
  it('a stdout line that is not JSON fails the request and is never skipped', async () => {
    const { client } = await launchFixture('malformed');
    await expect(client.request(EMBED_REQUEST)).rejects.toMatchObject({
      name: 'WorkerProtocolError',
      code: 'MALFORMED_FRAME',
      violation: expect.stringContaining('not valid JSON'),
    });
    // Contamination is channel-fatal: the client no longer runs.
    expect(client.clientState).toBe('dead');
  });

  it('an oversized worker line is reported as an oversized frame, not a parse error', async () => {
    const { client } = await launchFixture('oversized', {}, { maxFrameBytes: 2048 });
    const failure = await client.request(EMBED_REQUEST).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkerProtocolError);
    const protocolError = failure as WorkerProtocolError;
    expect(protocolError.code).toBe('MALFORMED_FRAME');
    expect(protocolError.violation).toContain('exceeds the negotiated maxFrameBytes');
    expect(client.clientState).toBe('dead');
  });

  it('an outbound request larger than the negotiated limit is refused before writing', async () => {
    const { client, logPath } = await launchFixture('happy', {}, { maxFrameBytes: 512 });
    await expect(
      client.request({ ...EMBED_REQUEST, params: { blob: 'x'.repeat(2048) } }),
    ).rejects.toMatchObject({
      name: 'WorkerProtocolError',
      code: 'MALFORMED_FRAME',
      violation: expect.stringContaining('exceeds the negotiated maxFrameBytes'),
    });

    await until(() => readLog(logPath).some((entry) => entry.event === 'stdin'));
    const requests = readLog(logPath).filter((entry) => {
      if (entry.event !== 'stdin') return false;
      const frame = JSON.parse(String(entry.line)) as { kind?: string };
      return frame.kind === 'request';
    });
    expect(requests).toEqual([]);
  });
});

describe('worker death mid-request', () => {
  it('a crashing worker fails the in-flight request as a launch failure', async () => {
    const { client } = await launchFixture('crash');
    const failure = await client.request(EMBED_REQUEST).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkerLaunchError);
    expect(failure).not.toBeInstanceOf(WorkerProtocolError);
    const launchError = failure as WorkerLaunchError;
    expect(launchError.kind).toBe('worker-died');
    expect(launchError.retryable).toBe(true);
    expect(launchError.message).toContain('code 1');
    expect(client.clientState).toBe('dead');
  });
});
