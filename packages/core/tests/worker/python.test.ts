import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerClient } from '../../src/worker/index.js';
import { teardown, TEST_BUDGET, track } from './helpers.js';

/**
 * The optional python seam: the interpreter is configurable, so the same
 * client drives a python worker when python3 is present. Skipped otherwise;
 * the suite never requires python.
 */
vi.setConfig({ testTimeout: 15_000 });

const PYTHON_PROBE = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const PYTHON_AVAILABLE = PYTHON_PROBE.status === 0;

afterEach(async () => {
  await teardown();
});

describe.skipIf(!PYTHON_AVAILABLE)('python interpreter seam', () => {
  it('the same client handshakes with and echoes through a python worker', async () => {
    const { PYTHON_FIXTURE } = await import('./helpers.js');
    const client = track(
      await WorkerClient.launch({
        interpreter: 'python3',
        scriptPath: PYTHON_FIXTURE,
      }),
    );

    expect(client.hello.supportedOperations).toEqual(['vision.embed']);
    expect(client.hello.capabilities.device).toBe('cpu');

    const outcome = await client.request({
      operation: 'vision.embed',
      workspaceId: 'ws-py',
      params: { images: ['a.png'], model: 'siglip2-base' },
      budget: { ...TEST_BUDGET },
    });

    expect(outcome.result).toEqual({
      operation: 'vision.embed',
      params: { images: ['a.png'], model: 'siglip2-base' },
      interpreter: 'python',
    });
  });
});
