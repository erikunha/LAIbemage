import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Each test spawns up to three bin processes (~4.6s each in coverage mode);
// the vitest 5s default would flake. 30s holds even on slow CI runners.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Golden help-parity test (spec 001, task 3.2).
 *
 * Pre-migration behavior (captured from the single-package CLI at the
 * feat/visual-lens baseline): `--help` exits 1 with exactly
 * "error: unknown option '--help'" on stderr, because the program is
 * registered with `.helpOption(false)` (help text lives in `help.ts` and is
 * printed by the action handler, not by Commander's built-in --help).
 *
 * The migration contract is PARITY, not the specific bytes:
 *   - `vision-lens --help` (dist/index.js) stays byte-identical to pre-migration output
 *   - `ai-image-labeling --help` (dist/compat.js) = same output plus exactly
 *     one extra stderr deprecation line (suppressible via VISION_LENS_NO_DEPRECATION=1)
 *   - exit codes are equal
 *
 * Requires built binaries. Skips (fast unit runs) when dist is missing; the
 * integration entry point is: pnpm --filter @vision-lens/cli test:bins
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_BIN = path.join(__dirname, '..', 'dist', 'index.js');
const COMPAT_BIN = path.join(__dirname, '..', 'dist', 'compat.js');
const BINS_BUILT = existsSync(INDEX_BIN) && existsSync(COMPAT_BIN);

const DEPRECATION_LINE =
  "warning: 'ai-image-labeling' is deprecated; use 'vision-lens' (see README Vision Lens evolution)";

interface BinResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

function runBin(bin: string, env: NodeJS.ProcessEnv = {}): BinResult {
  const result = spawnSync(process.execPath, [bin, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  expect(result.error).toBeUndefined();
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

/** Extract the subcommand names a bin advertises in usage/help lines. */
function extractCommands(stdout: string): string[] {
  const commands = new Set<string>();
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(?:vision-lens|ai-image-labeling)\s+(\S+)/);
    if (match && !match[1].startsWith('-')) commands.add(match[1]);
  }
  return [...commands].sort();
}

describe.skipIf(!BINS_BUILT)(
  'golden help parity: vision-lens (dist/index.js) vs ai-image-labeling (dist/compat.js) — requires built dist (pnpm --filter @vision-lens/cli test:bins)',
  () => {
    it('vision-lens --help matches the captured pre-migration output byte-for-byte', () => {
      const index = runBin(INDEX_BIN);
      expect(index.stdout).toBe('');
      expect(index.stderr).toBe('error: unknown option \'--help\'\n');
      expect(index.status).toBe(1);
    });

    it('compat --help output equals vision-lens --help output (same command list, same stdout)', () => {
      const index = runBin(INDEX_BIN);
      const compat = runBin(COMPAT_BIN);
      expect(compat.stdout).toBe(index.stdout);
      expect(extractCommands(compat.stdout)).toEqual(extractCommands(index.stdout));
    });

    it('compat --help adds exactly one deprecation line to stderr and keeps the exit code', () => {
      const index = runBin(INDEX_BIN);
      const compat = runBin(COMPAT_BIN);

      const deprecationLines = compat.stderr.split('\n').filter((l) => l.includes('deprecated'));
      expect(deprecationLines).toHaveLength(1);
      expect(deprecationLines[0]).toBe(DEPRECATION_LINE);
      expect(compat.stderr).toBe(`${DEPRECATION_LINE}\n${index.stderr}`);
      expect(compat.status).toBe(index.status);
    });

    it('VISION_LENS_NO_DEPRECATION=1 suppresses the deprecation line entirely', () => {
      const index = runBin(INDEX_BIN);
      const compat = runBin(COMPAT_BIN, { VISION_LENS_NO_DEPRECATION: '1' });
      expect(compat.stderr).toBe(index.stderr);
      expect(compat.stderr).not.toContain('deprecated');
      expect(compat.status).toBe(index.status);
    });
  },
);
