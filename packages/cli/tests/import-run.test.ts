import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * `laib import-run` — the user flow (spec 002, task 4.3 / 7.2).
 *
 * The command is driven through the REAL BINARY, because the user flow is
 * the product: the counts on stdout, the rows in the store, the exit code.
 *
 * Requires built binaries. Skips (fast unit runs) when dist is missing; the
 * integration entry point is: pnpm --filter @master-vision/cli test:bins
 */

vi.setConfig({ testTimeout: 30_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_BIN = path.join(__dirname, '..', 'dist', 'index.js');
const BINS_BUILT = existsSync(INDEX_BIN);

/** A synthetic legacy run (never the repository's real analysis_results.json). */
const LEGACY_RUN = {
  processedDate: '2026-01-04T10:00:00.000Z',
  totalImages: 2,
  categories: ['kitchen', 'living_room'],
  images: [
    {
      originalFile: 'CLI-SYNTHETIC-001.jpg',
      outputFile: '001. Synthetic photo dated 01-01-2026.jpeg',
      category: 'kitchen',
      number: 1,
      shortDescription: 'synthetic kitchen',
      elements: ['sink'],
      condition: 'good',
      timestamp: 1766292071829,
    },
    {
      originalFile: 'CLI-SYNTHETIC-002.jpg',
      outputFile: '002. Synthetic photo dated 02-01-2026.jpeg',
      category: 'living_room',
      number: 2,
      shortDescription: 'synthetic living room',
      elements: ['sofa'],
      condition: 'damaged',
      timestamp: 1753510199165.367,
    },
  ],
};

interface BinResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

/** Runs the built `laib` binary with the given arguments. */
function runBin(args: string[]): BinResult {
  const result = spawnSync(process.execPath, [INDEX_BIN, ...args], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

/** Creates a legacy workspace: <tmp>/output/analysis_results.json + <tmp>/input. */
function makeLegacyWorkspace(): { dir: string; runPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mv-cli-import-'));
  const outputDir = path.join(dir, 'output');
  const inputDir = path.join(dir, 'input');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(inputDir, { recursive: true });
  const runPath = path.join(outputDir, 'analysis_results.json');
  writeFileSync(runPath, JSON.stringify(LEGACY_RUN, null, 2));
  // Only ONE of the two images is reachable: the other one must come back as
  // an `unhashed` asset.
  writeFileSync(path.join(inputDir, 'CLI-SYNTHETIC-001.jpg'), 'synthetic bytes');
  return { dir, runPath };
}

/** The count lines of an import output. */
function countLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => /^(assets|samples|predictions|annotations|capture|ontology|model|experiment|legacy)/.test(line));
}

describe.skipIf(!BINS_BUILT)(
  'laib import-run (requires built dist — pnpm --filter @master-vision/cli test:bins)',
  () => {
    it('previews the mapping with --dry-run and writes NOTHING', async () => {
      const workspace = makeLegacyWorkspace();
      const dbPath = path.join(workspace.dir, 'store.db');
      try {
        const result = runBin(['import-run', workspace.runPath, '--dry-run', '--db', dbPath]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('assets:          2 (hashed 1, unhashed 1)');
        expect(result.stdout).toContain('predictions:     2');
        expect(result.stdout).toContain('dry run');
        // Nothing was written: not even the database file.
        expect(existsSync(dbPath)).toBe(false);
      } finally {
        rmSync(workspace.dir, { recursive: true, force: true });
      }
    });

    it('imports the run and prints the SAME counts the dry run printed', async () => {
      const workspace = makeLegacyWorkspace();
      const dbPath = path.join(workspace.dir, 'store.db');
      try {
        const dry = runBin(['import-run', workspace.runPath, '--dry-run', '--db', dbPath]);
        const real = runBin(['import-run', workspace.runPath, '--db', dbPath]);

        expect(real.status).toBe(0);
        expect(countLines(real.stdout)).toEqual(countLines(dry.stdout));
        expect(existsSync(dbPath)).toBe(true);

        // The rows really landed.
        const store = await import('@master-vision/core/store');
        const handle = await store.openMigratedStore(dbPath);
        try {
          const count = (table: string): number =>
            (handle.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
          expect(count('assets')).toBe(2);
          expect(count('samples')).toBe(2);
          expect(count('predictions')).toBe(2);
          expect(count('experiment_runs')).toBe(1);
          expect(count('legacy_imports')).toBe(1);
        } finally {
          handle.close();
        }
      } finally {
        rmSync(workspace.dir, { recursive: true, force: true });
      }
    });

    it('is idempotent: a second import writes nothing and says so', () => {
      const workspace = makeLegacyWorkspace();
      const dbPath = path.join(workspace.dir, 'store.db');
      try {
        const first = runBin(['import-run', workspace.runPath, '--db', dbPath]);
        const second = runBin(['import-run', workspace.runPath, '--db', dbPath]);

        expect(first.status).toBe(0);
        expect(second.status).toBe(0);
        expect(second.stdout).toContain('already imported');
        expect(countLines(second.stdout)).toEqual(countLines(first.stdout));
      } finally {
        rmSync(workspace.dir, { recursive: true, force: true });
      }
    });

    it('fails with a clear message and a non-zero exit code on a missing file', () => {
      const workspace = makeLegacyWorkspace();
      const dbPath = path.join(workspace.dir, 'store.db');
      try {
        const result = runBin([
          'import-run',
          path.join(workspace.dir, 'does-not-exist.json'),
          '--db',
          dbPath,
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('not found');
      } finally {
        rmSync(workspace.dir, { recursive: true, force: true });
      }
    });

    it('fails with a clear message when the file is not a legacy run', () => {
      const workspace = makeLegacyWorkspace();
      const dbPath = path.join(workspace.dir, 'store.db');
      try {
        const bogus = path.join(workspace.dir, 'bogus.json');
        writeFileSync(bogus, JSON.stringify({ hello: 'world' }));
        const result = runBin(['import-run', bogus, '--db', dbPath]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Unrecognised legacy run shape');
      } finally {
        rmSync(workspace.dir, { recursive: true, force: true });
      }
    });
  },
);
