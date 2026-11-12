import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * Crash consistency (spec 002, task 3.3, SC-004).
 *
 * A CHILD PROCESS opens the store, commits a row, starts a transaction,
 * writes another row and blocks. The parent kills it with **SIGKILL** — a
 * hard kill, no graceful close, no chance to roll back — and then reopens
 * the database and asserts that:
 *
 *  - the database opens without corruption (`PRAGMA integrity_check`);
 *  - the schema is intact;
 *  - the committed row is still there;
 *  - the transaction that was in flight when the process died is NOT visible.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, 'store-child.mjs');

/** Spawns the child fixture and resolves with its exit metadata. */
function spawnChild(mode: string, dbPath: string, signalFile: string, resultFile?: string) {
  const args = [childScript, mode, dbPath, signalFile];
  if (resultFile) args.push(resultFile);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, stderr: () => stderr };
}

/** Waits until a file appears (the child signals through it). */
async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for '${file}'`);
}

describe('crash consistency (kill -9 mid-transaction)', () => {
  it('leaves the database consistent after a SIGKILL', async () => {
    const dir = makeTempDir('mv-store-crash-');
    const dbPath = path.join(dir, 'store.db');
    const signalFile = path.join(dir, 'signal');

    const { child, exited, stderr } = spawnChild('crash', dbPath, signalFile);

    try {
      // Wait until the child is inside its open transaction.
      await waitForFile(signalFile);
      expect(readFileSync(signalFile, 'utf8')).toBe('in-transaction');

      // Kill it hard: no signal handler, no graceful close.
      child.kill('SIGKILL');
      const result = await exited;
      expect(result.signal).toBe('SIGKILL');
      expect(stderr()).toBe('');

      // The database survived: reopen it and look at what is there.
      const store = await openStore(dbPath);
      try {
        const integrity = store.db.pragma('integrity_check') as { integrity_check: string }[];
        expect(integrity[0]!.integrity_check).toBe('ok');

        // The schema is intact.
        const tables = store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];
        const names = tables.map((row) => row.name);
        expect(names).toContain('assets');
        expect(names).toContain('annotations');
        expect(names).toContain('schema_migrations');

        // The committed row is still there.
        const committed = store.db
          .prepare('SELECT * FROM assets WHERE id = ?')
          .get('committed-asset');
        expect(committed).toBeDefined();

        // The transaction that was in flight when the process died left no
        // trace: an uncommitted transaction is not visible.
        const uncommitted = store.db
          .prepare('SELECT * FROM assets WHERE id = ?')
          .get('uncommitted-asset');
        expect(uncommitted).toBeUndefined();

        const count = store.db.prepare('SELECT COUNT(*) AS c FROM assets').get() as { c: number };
        expect(count.c).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      removeTempDir(dir);
    }
  }, 30_000);

  it('leaves the recovered database writable', async () => {
    const dir = makeTempDir('mv-store-crash-');
    const dbPath = path.join(dir, 'store.db');
    const signalFile = path.join(dir, 'signal');

    const { child, exited } = spawnChild('crash', dbPath, signalFile);

    try {
      await waitForFile(signalFile);
      child.kill('SIGKILL');
      await exited;

      // The store is not merely readable — it is fully usable again.
      const store = await openStore(dbPath);
      try {
        const asset = store.db
          .prepare(
            `INSERT INTO assets (id, sha256, kind, unhashed, path, created_at, updated_at)
             VALUES ('after-recovery', ?, 'image', 0, '/tmp/after.jpg', ?, ?)`,
          )
          .run('d'.repeat(64), '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');

        expect(asset.changes).toBe(1);
        const count = store.db.prepare('SELECT COUNT(*) AS c FROM assets').get() as { c: number };
        expect(count.c).toBe(2);
      } finally {
        store.close();
      }
    } finally {
      removeTempDir(dir);
    }
  }, 30_000);
});
