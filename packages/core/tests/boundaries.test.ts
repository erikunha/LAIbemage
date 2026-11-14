import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Module-boundary enforcement (spec 001, task 2.3): the eslint
 * `no-restricted-imports` rule must reject LLM SDK imports outside
 * `packages/core/src/analyzer/providers/**` (AGENTS.md boundary table).
 *
 * Delegates to scripts/check-boundaries.mjs (also `pnpm run check:boundaries`),
 * which lints a violating fixture and a clean fixture and asserts exit codes.
 */
vi.setConfig({ testTimeout: 60_000 }); // spawns eslint (config load ~seconds)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const boundaryScript = path.join(repoRoot, 'scripts', 'check-boundaries.mjs');
const ownerScript = path.join(repoRoot, 'scripts', 'check-owner-boundaries.mjs');

/** The directories that are build output, caches or dependencies. */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.turbo',
  '.venv',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

/**
 * Every file of the given roots, with its size and its modification time.
 *
 * The roots are the trees the owner boundary checker walks, and nothing
 * else: the snapshot is about what a reader of the tree would find, and the
 * rest of the repository moves under other tests while this one runs.
 */
function treeSnapshot(root: string, roots: string[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      try {
        const stats = statSync(absolute);
        snapshot.set(path.relative(root, absolute), stats.size + ':' + stats.mtimeMs);
      } catch {
        // A file that vanished while the tree was read is not in it.
      }
    }
  };
  for (const relative of roots) walk(path.join(root, relative));
  return snapshot;
}

/** The trees the owner boundary checker walks. */
const OWNER_SCANNED_ROOTS = ['packages/core/src/worker', 'python', 'services'];

describe('module boundary enforcement (eslint no-restricted-imports)', () => {
  it('rejects an LLM SDK import outside providers/ and passes a clean file', () => {
    const result = spawnSync(process.execPath, [boundaryScript], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('boundary check passed');
  });

  it('proves the rules without planting a fixture the other checker can read', async () => {
    // The fixtures are linted from stdin under a virtual filename, so the
    // checker writes NOTHING into the repository. That matters: a planted
    // violation is a violation, and while it sat in the tree the owner
    // boundary checker read it as source and reported HOST-IMPORTS on a tree
    // that was clean. The suite failed intermittently, under load, naming a
    // directory nobody had written on purpose.
    //
    // The guard is the INVARIANT, not the mechanism: while the boundary
    // checker runs, the owner boundary checker must keep passing. A checker
    // that plants a fixture again, with any API, into any directory, in a
    // way that lasts long enough to be read, fails this test.
    const before = treeSnapshot(repoRoot, OWNER_SCANNED_ROOTS);
    const child = spawn(process.execPath, [boundaryScript], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    let ownerRuns = 0;
    while (child.exitCode === null && ownerRuns < 40) {
      const owner = spawnSync(process.execPath, [ownerScript], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      ownerRuns += 1;
      // The tree is clean WHILE the boundary checker is running.
      expect(owner.status, owner.stderr).toBe(0);
      expect(owner.stderr).toBe('');
    }
    expect(ownerRuns).toBeGreaterThan(0);

    const finished = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });
    expect(await finished).toBe(0);
    expect(stdout).toContain('boundary check passed');

    // And nothing was left behind.
    expect([...treeSnapshot(repoRoot, OWNER_SCANNED_ROOTS)]).toEqual([...before]);
  });
});
