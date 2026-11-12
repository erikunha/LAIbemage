import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerClient, type WorkerClientOptions } from '../../src/worker/index.js';
import { newFixtureLog, teardown, TEST_BUDGET, track } from './helpers.js';

/**
 * Channel-level error frames with no requestId: the error envelope is the one
 * schema that documents an OPTIONAL requestId, absent exactly when the id
 * could not be recovered from the line (the Python worker emits this form via
 * channel_error_frame). The host must surface the frame through onViolation
 * as a typed protocol violation and keep the channel alive.
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

/**
 * A JS fixture worker in the spirit of fixtures/fixture-worker.mjs: it speaks
 * the frozen visionlens.worker.v1 protocol, and on its FIRST request it emits
 * the id-less error frame form (no requestId, no seq) before serving that
 * request like any other. Every later request is served directly, so the
 * assertions observe the host on one continuously live channel.
 */
const WORKER_SOURCE = String.raw`// Channel-error fixture worker for the host client tests.
import process from 'node:process';
import { createInterface } from 'node:readline';

const PROTOCOL = 'visionlens.worker.v1';
let channelErrorsSent = 0;

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

send({
  protocol: PROTOCOL,
  kind: 'hello',
  protocolVersion: '1.0.0',
  contractVersion: '1.0.0',
  supportedOperations: ['vision.embed'],
  capabilities: { device: 'cpu', extras: [], models: [] },
  maxFrameBytes: 1048576,
});

createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.kind !== 'request') return;
  if (channelErrorsSent === 0) {
    channelErrorsSent += 1;
    // The documented unrecoverable-id form: neither requestId nor seq.
    send({
      protocol: PROTOCOL,
      kind: 'error',
      code: 'MALFORMED_FRAME',
      message: 'the request id could not be recovered from the line',
      retryable: false,
    });
  }
  send({
    protocol: PROTOCOL,
    kind: 'progress',
    requestId: frame.requestId,
    seq: 0,
    completed: 1,
    total: 2,
  });
  send({
    protocol: PROTOCOL,
    kind: 'result',
    requestId: frame.requestId,
    seq: 1,
    result: { echoed: true },
  });
});
`;

/** Launches the channel-error worker; its script lands in a tracked temp dir. */
async function launchChannelErrorWorker(
  options: Partial<WorkerClientOptions> = {},
): Promise<WorkerClient> {
  const logPath = newFixtureLog();
  const scriptPath = path.join(path.dirname(logPath), 'channel-error-worker.mjs');
  writeFileSync(scriptPath, WORKER_SOURCE);
  const client = await WorkerClient.launch({
    interpreter: process.execPath,
    scriptPath,
    ...options,
  });
  return track(client);
}

describe('channel-level errors with no requestId', () => {
  it('an id-less error frame is reported as a violation and the channel keeps serving', async () => {
    const violations: string[] = [];
    const client = await launchChannelErrorWorker({
      onViolation: (violation) => violations.push(violation),
    });

    // The worker emits the id-less error frame first and then serves this
    // very request: the frame must not settle, fail or misroute it.
    const first = await client.request({ ...EMBED_REQUEST, requestId: 'r-first' });
    expect(first.requestId).toBe('r-first');
    expect(first.seq).toBe(1);
    expect(first.result).toEqual({ echoed: true });

    // The frame surfaced through the documented violation channel, carrying
    // the typed code and the worker message.
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('channel-level error');
    expect(violations[0]).toContain('MALFORMED_FRAME');
    expect(violations[0]).toContain('the request id could not be recovered');

    // The violation did not kill the connection: the client still runs.
    expect(client.clientState).toBe('running');

    // A subsequent valid request still completes on the same channel.
    const second = await client.request({ ...EMBED_REQUEST, requestId: 'r-second' });
    expect(second.requestId).toBe('r-second');
    expect(second.result).toEqual({ echoed: true });
    expect(client.clientState).toBe('running');
    expect(violations).toHaveLength(1);
  });
});
