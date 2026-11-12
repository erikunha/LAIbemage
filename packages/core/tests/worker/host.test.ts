import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerClient, WorkerLaunchError } from '../../src/worker/index.js';
import {
  isAllowedWorkerInterpreter,
  spawnWorkerProcess,
  WORKER_INTERPRETER_ALLOWLIST,
} from '../../src/worker/host.js';
import { FIXTURE_WORKER, launchFixture, teardown } from './helpers.js';

/**
 * Task 1.5 (FR-014): the worker process is launched from a FIXED allowlist,
 * every inherited channel except the request pipe is closed, and an asset
 * path is never interpolated into a command.
 *
 * The spawn seam is injectable, so the argv and the stdio the host hands to
 * child_process.spawn are asserted directly: no shell, no command string, no
 * inherited fd. The live test at the bottom proves the refusal through the
 * public WorkerClient.launch path.
 */
vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await teardown();
});

describe('the interpreter allowlist', () => {
  it('allows every fixed name and the executable the host itself runs under', () => {
    for (const name of WORKER_INTERPRETER_ALLOWLIST) {
      expect(isAllowedWorkerInterpreter(name)).toBe(true);
    }
    // The fixture worker runs under the host's own interpreter; the allowlist
    // admits it by identity, never by caller choice.
    expect(isAllowedWorkerInterpreter(process.execPath)).toBe(true);
  });

  it('refuses a path, a shell, and anything else outside the allowlist', () => {
    for (const value of [
      '/bin/sh',
      '/usr/bin/python3',
      '../python3',
      'python3; rm -rf /',
      'python3 -c code',
      'sh',
      'bash',
      '',
      'PYTHON3',
    ]) {
      expect(isAllowedWorkerInterpreter(value)).toBe(false);
    }
  });
});

describe('spawnWorkerProcess', () => {
  /** Records the spawn call and returns a stub child. */
  function recordingSpawn() {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const fake = ((command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      return { killed: false } as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    return { fake, calls };
  }

  it('spawns the interpreter with the script as argv, no shell, pipes only', () => {
    const { fake, calls } = recordingSpawn();
    spawnWorkerProcess(
      {
        interpreter: 'python3',
        scriptPath: 'worker.py',
        scriptArgs: ['--verbose'],
        env: { PATH: '/bin' },
      },
      { spawnFn: fake },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('python3');
    // The script path and its arguments are SEPARATE argv entries: an asset
    // path is never interpolated into a command string.
    expect(calls[0]!.args).toEqual(['worker.py', '--verbose']);
    const options = calls[0]!.options as {
      stdio: unknown;
      shell: boolean;
      env: NodeJS.ProcessEnv;
    };
    // Every channel is a pipe owned by the host: nothing is inherited from
    // the host's own stdin/stdout/stderr, and no extra fd is passed down.
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.shell).toBe(false);
    expect(options.env).toEqual({ PATH: '/bin' });
  });

  it('refuses an interpreter outside the allowlist before any spawn happens', () => {
    const { fake, calls } = recordingSpawn();
    expect(() =>
      spawnWorkerProcess(
        { interpreter: '/bin/sh', scriptPath: 'worker.py' },
        { spawnFn: fake },
      ),
    ).toThrow(WorkerLaunchError);

    expect(calls).toHaveLength(0);
    try {
      spawnWorkerProcess({ interpreter: '/bin/sh', scriptPath: 'worker.py' }, { spawnFn: fake });
    } catch (error) {
      const launch = error as WorkerLaunchError;
      expect(launch.kind).toBe('spawn-error');
      expect(launch.message).toContain('/bin/sh');
      expect(launch.message).toContain('allowlist');
    }
  });
});

describe('WorkerClient.launch enforces the allowlist', () => {
  it('an interpreter outside the allowlist is refused, even through the environment', async () => {
    const before = process.env.VISION_LENS_WORKER_INTERPRETER;
    process.env.VISION_LENS_WORKER_INTERPRETER = '/bin/zsh';
    try {
      let thrown: unknown;
      try {
        // No explicit interpreter: the environment variable is the only
        // source, and the allowlist refusal fires before any process exists.
        await WorkerClient.launch({ scriptPath: FIXTURE_WORKER });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkerLaunchError);
      expect((thrown as WorkerLaunchError).kind).toBe('spawn-error');
      expect((thrown as WorkerLaunchError).message).toContain('allowlist');
    } finally {
      if (before === undefined) delete process.env.VISION_LENS_WORKER_INTERPRETER;
      else process.env.VISION_LENS_WORKER_INTERPRETER = before;
    }
  });

  it('the allowlisted fixture interpreter still launches and handshakes', async () => {
    const { client } = await launchFixture('happy');
    expect(client.clientState).toBe('running');
  });
});
