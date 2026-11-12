import { spawn, type ChildProcess } from 'node:child_process';
import { WorkerLaunchError } from './errors.js';

/**
 * The launch surface of the worker host (task 1.5, FR-014).
 *
 * Three rules are enforced HERE, before any process exists:
 *
 *  1. **Fixed allowlist.** The worker process is started only through an
 *     interpreter named in {@link WORKER_INTERPRETER_ALLOWLIST} (or through
 *     the exact executable the host itself runs under, which tests and
 *     tooling rely on). A path, a shell, or any other caller-supplied value
 *     is refused before spawn: the executable position of the child is never
 *     a free-form string.
 *  2. **No inherited channel.** The child is spawned with exactly three
 *     pipes, all owned by the host: stdin is the request pipe (the only
 *     channel the child can write back through is its own stdout and stderr
 *     pipes), stdout carries frames, stderr carries logs. Nothing is
 *     inherited from the host process, and no fourth fd is passed down.
 *  3. **No shell interpolation.** `shell: false`, always. The script path
 *     and its arguments travel as separate argv entries, so an asset path is
 *     never interpolated into a command string.
 */

/**
 * The fixed allowlist of interpreter executables (FR-014).
 *
 * Bare, PATH-resolved names only: a value containing a path separator, a
 * space or a shell metacharacter can never be a member of this list.
 */
export const WORKER_INTERPRETER_ALLOWLIST = [
  'python',
  'python3',
  'python3.11',
  'python3.12',
  'python3.13',
  'node',
] as const;

/** The stdio the child gets: three host-owned pipes, nothing inherited. */
const WORKER_STDIO = ['pipe', 'pipe', 'pipe'] as const;

/**
 * True when `interpreter` may launch a worker process.
 *
 * Two and only two shapes pass:
 *
 *  - a name that is a member of the fixed allowlist, and
 *  - the exact executable the host process itself runs under
 *    (`process.execPath`), admitted by IDENTITY: the fixture worker of the
 *    test suite and tooling spawned from inside this process run under it.
 *    It is a machine-fixed value, never a caller choice.
 */
export function isAllowedWorkerInterpreter(interpreter: string): boolean {
  if ((WORKER_INTERPRETER_ALLOWLIST as readonly string[]).includes(interpreter)) return true;
  return interpreter === process.execPath;
}

/** The launch description handed to {@link spawnWorkerProcess}. */
export interface WorkerSpawnInput {
  /** The interpreter executable; MUST pass {@link isAllowedWorkerInterpreter}. */
  readonly interpreter: string;
  /** The worker entry the interpreter runs, as its first argv element. */
  readonly scriptPath: string;
  /** Extra argv entries after the script path. */
  readonly scriptArgs?: readonly string[];
  /** The child environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Options of {@link spawnWorkerProcess}. */
export interface WorkerSpawnOptions {
  /**
   * The spawn function. Injectable so tests assert the exact argv, stdio and
   * shell flag without running a process; defaults to `child_process.spawn`.
   */
  readonly spawnFn?: typeof spawn;
}

/**
 * Spawns the worker process under the rules above.
 *
 * Throws {@link WorkerLaunchError} (`spawn-error`) when the interpreter is
 * outside the allowlist: BEFORE any process is created, so a refused launch
 * has no side effect at all.
 */
export function spawnWorkerProcess(
  input: WorkerSpawnInput,
  options: WorkerSpawnOptions = {},
): ChildProcess {
  const { interpreter, scriptPath, scriptArgs, env } = input;
  if (!isAllowedWorkerInterpreter(interpreter)) {
    throw new WorkerLaunchError(
      'spawn-error',
      `the interpreter "${interpreter}" is not in the worker launch allowlist ` +
        `(${[...WORKER_INTERPRETER_ALLOWLIST].join(', ')}, or the running executable); ` +
        'the worker process must be launched from the fixed allowlist',
    );
  }
  const spawnFn = options.spawnFn ?? spawn;
  return spawnFn(interpreter, [scriptPath, ...(scriptArgs ?? [])], {
    stdio: [...WORKER_STDIO],
    env,
    shell: false,
  });
}
