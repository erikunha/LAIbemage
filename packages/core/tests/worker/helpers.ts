import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerClient, type WorkerClientOptions } from '../../src/worker/index.js';

/**
 * Shared harness for the worker host client tests.
 *
 * Every test drives the real client against the fixture worker script through
 * process.execPath, so no network and no python are required. The fixture
 * writes what it observed (its own pid, every stdin line, lifecycle events)
 * to a log file the assertions read back: tests assert observable behaviour,
 * never the source of another module.
 */

export const FIXTURE_WORKER = fileURLToPath(new URL('./fixtures/fixture-worker.mjs', import.meta.url));
export const PYTHON_FIXTURE = fileURLToPath(new URL('./fixtures/protocol_echo.py', import.meta.url));

const openClients: WorkerClient[] = [];
const openDirs: string[] = [];

/** Launches the fixture worker in the given mode, with its log path. */
export async function launchFixture(
  mode: string,
  env: Record<string, string> = {},
  options: Partial<WorkerClientOptions> = {},
): Promise<{ client: WorkerClient; logPath: string }> {
  const logPath = newFixtureLog();
  const client = await WorkerClient.launch({
    interpreter: process.execPath,
    scriptPath: FIXTURE_WORKER,
    env: { FIXTURE_MODE: mode, FIXTURE_LOG: logPath, ...env },
    ...options,
  });
  return { client: track(client), logPath };
}

/** Launches the fixture worker expecting the launch itself to fail. */
export async function launchFixtureExpectingError(
  mode: string,
  env: Record<string, string> = {},
  options: Partial<WorkerClientOptions> = {},
): Promise<{ error: unknown; logPath: string }> {
  const logPath = newFixtureLog();
  let error: unknown;
  try {
    await WorkerClient.launch({
      interpreter: process.execPath,
      scriptPath: FIXTURE_WORKER,
      env: { FIXTURE_MODE: mode, FIXTURE_LOG: logPath, ...env },
      ...options,
    });
  } catch (caught) {
    error = caught;
  }
  return { error, logPath };
}

/** Registers a client for teardown and returns it. */
export function track(client: WorkerClient): WorkerClient {
  openClients.push(client);
  return client;
}

/** A fresh fixture log path (created under a temp dir that is removed later). */
export function newFixtureLog(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vl-worker-test-'));
  openDirs.push(dir);
  return path.join(dir, 'log.jsonl');
}

/** Reads a fixture log as parsed jsonl entries. */
export function readLog(logPath: string): Array<Record<string, unknown>> {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Resolves true once the process with the given pid is gone. */
export async function waitForPidExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Resolves once the predicate holds, or throws after the timeout. */
export async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before the timeout');
}

/** Closes every tracked client and removes every temp dir. Call in afterEach. */
export async function teardown(): Promise<void> {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A valid budget for tests, on the fast end of the allowed range. */
export const TEST_BUDGET = { maxSeconds: 30, maxUsdMicro: 0 } as const;
