import { spawnSync } from 'node:child_process';
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

describe('module boundary enforcement (eslint no-restricted-imports)', () => {
  it('rejects an LLM SDK import outside providers/ and passes a clean file', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'check-boundaries.mjs')],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('boundary check passed');
  });
});
