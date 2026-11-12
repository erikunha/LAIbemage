import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkerClient,
  WorkerLaunchError,
  WorkerProtocolError,
  WORKER_INTERPRETER_ENV,
  WORKER_SCRIPT_ENV,
} from '../../src/worker/index.js';
import {
  FIXTURE_WORKER,
  launchFixture,
  launchFixtureExpectingError,
  readLog,
  teardown,
  until,
} from './helpers.js';

/**
 * Handshake behaviour: the worker speaks first, the host answers, and every
 * handshake failure is classified before any operation is accepted.
 */
vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await teardown();
});

describe('worker handshake', () => {
  it('validates the worker hello and answers with the host hello', async () => {
    const { client, logPath } = await launchFixture('happy');

    expect(client.hello.supportedOperations).toEqual(['vision.embed']);
    expect(client.hello.maxFrameBytes).toBe(1_048_576);
    expect(client.hello.capabilities).toEqual({ device: 'cpu', extras: [], models: [] });
    expect(client.clientState).toBe('running');

    // The fixture observed exactly one line before any request: the host hello.
    // The fixture logs its stdin asynchronously, so wait for the observable.
    await until(() => readLog(logPath).some((entry) => entry.event === 'stdin'));
    const stdinLines = readLog(logPath).filter((entry) => entry.event === 'stdin');
    expect(stdinLines).toHaveLength(1);
    const hostHello = JSON.parse(String(stdinLines[0].line)) as Record<string, unknown>;
    // The answer is EXACTLY the five version/carry fields: the worker's
    // validator rejects any extra field, so no operations or capabilities.
    expect(hostHello).toEqual({
      protocol: 'visionlens.worker.v1',
      kind: 'hello',
      protocolVersion: '1.0.0',
      contractVersion: '1.0.0',
      maxFrameBytes: 1_048_576,
    });
  });

  it('negotiates the smaller frame limit of the two hellos', async () => {
    const { client } = await launchFixture('happy', {}, { maxFrameBytes: 4096 });
    expect(client.hello.maxFrameBytes).toBe(1_048_576);
    expect(client.maxFrameBytes).toBe(4096);
  });

  it('a worker that never sends hello is a launch failure, not a protocol error', async () => {
    const { error } = await launchFixtureExpectingError(
      'late-hello',
      { FIXTURE_DELAY_MS: '10000' },
      { handshakeTimeoutMs: 250 },
    );
    expect(error).toBeInstanceOf(WorkerLaunchError);
    expect(error).not.toBeInstanceOf(WorkerProtocolError);
    expect((error as WorkerLaunchError).kind).toBe('handshake-timeout');
  });

  it('a worker that dies before the hello is a launch failure', async () => {
    const { error } = await launchFixtureExpectingError('die-before-hello');
    expect(error).toBeInstanceOf(WorkerLaunchError);
    expect((error as WorkerLaunchError).kind).toBe('worker-died');
    expect((error as WorkerLaunchError).message).toContain('handshake');
  });

  it('a worker speaking another protocol major is refused before any frame is written', async () => {
    const { error, logPath } = await launchFixtureExpectingError('mismatch', {
      FIXTURE_PROTOCOL: 'visionlens.worker.v2',
    });

    expect(error).toBeInstanceOf(WorkerProtocolError);
    const protocolError = error as WorkerProtocolError;
    expect(protocolError.code).toBe('UNSUPPORTED_PROTOCOL');
    // The refusal names both protocol ids.
    expect(protocolError.message).toContain('visionlens.worker.v2');
    expect(protocolError.message).toContain('visionlens.worker.v1');

    // The host wrote NOTHING to the worker: no host hello, no request.
    expect(readLog(logPath).filter((entry) => entry.event === 'stdin')).toEqual([]);
  });

  it('a worker hello with a mismatched contract major is refused', async () => {
    // The fixture announces contractVersion 1.0.0; the host below claims 2.x.
    const { error } = await launchFixtureExpectingError('happy', {}, { contractVersion: '2.0.0' });
    expect(error).toBeInstanceOf(WorkerProtocolError);
    expect((error as WorkerProtocolError).code).toBe('UNSUPPORTED_PROTOCOL');
    expect((error as WorkerProtocolError).message).toContain('contract major');
  });

  it('a spawn error is a launch failure', async () => {
    await expect(
      WorkerClient.launch({ interpreter: '/nonexistent/interpreter-zzz', scriptPath: FIXTURE_WORKER }),
    ).rejects.toMatchObject({ name: 'WorkerLaunchError', kind: 'spawn-error' });
  });

  it('the interpreter and script come from the environment variables', async () => {
    const previousInterpreter = process.env[WORKER_INTERPRETER_ENV];
    const previousScript = process.env[WORKER_SCRIPT_ENV];
    process.env[WORKER_INTERPRETER_ENV] = process.execPath;
    process.env[WORKER_SCRIPT_ENV] = FIXTURE_WORKER;
    try {
      const client = await WorkerClient.launch({ env: { FIXTURE_MODE: 'happy' } });
      expect(client.clientState).toBe('running');
      expect(client.hello.supportedOperations).toEqual(['vision.embed']);
    } finally {
      if (previousInterpreter === undefined) delete process.env[WORKER_INTERPRETER_ENV];
      else process.env[WORKER_INTERPRETER_ENV] = previousInterpreter;
      if (previousScript === undefined) delete process.env[WORKER_SCRIPT_ENV];
      else process.env[WORKER_SCRIPT_ENV] = previousScript;
    }
  });
});
