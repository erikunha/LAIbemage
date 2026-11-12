import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMigrations, openStore } from '../../src/store/index.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * Concurrency (spec 002, FR-003: "single-writer assumptions documented").
 *
 * This is a REAL concurrency test: TWO PROCESSES write to the SAME database
 * file at the same time. One holds the write lock for ~1.2 s; the other
 * starts a write in that window and must WAIT for the lock (the
 * `busy_timeout = 5000` path) instead of failing with `SQLITE_BUSY`.
 *
 * The assertions are on the observed behaviour, not on a sequential proxy:
 * the second writer's write took at least as long as the lock was held, and
 * both rows are in the database afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, 'store-child.mjs');

function spawnChild(
  mode: string,
  dbPath: string,
  signalFile: string,
  resultFile?: string,
  waitForFile?: string,
) {
  const args = [childScript, mode, dbPath, signalFile];
  if (resultFile) args.push(resultFile);
  if (waitForFile) args.push(waitForFile);
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

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for '${file}'`);
}

describe('concurrent writers (busy_timeout path)', () => {
  it('makes the second writer wait for the lock instead of failing', async () => {
    const dir = makeTempDir('mv-store-concurrency-');
    const dbPath = path.join(dir, 'store.db');
    const holderSignal = path.join(dir, 'holder-signal');
    const writerSignal = path.join(dir, 'writer-signal');
    const writerResult = path.join(dir, 'writer-elapsed');

    // The parent migrates the database BEFORE the children start: the
    // children then only write, and no two processes race to create the
    // schema.
    const parent = await openStore(dbPath);
    try {
      applyMigrations(parent.db);
    } finally {
      parent.close();
    }

    const holder = spawnChild('hold', dbPath, holderSignal);
    // The writer waits for the HOLDER's signal: it must start its write
    // while the other process still owns the write lock.
    const writer = spawnChild('write', dbPath, writerSignal, writerResult, holderSignal);

    try {
      await waitForFile(holderSignal);

      const [holderExit, writerExit] = await Promise.all([holder.exited, writer.exited]);

      // Neither writer failed: the busy timeout absorbed the contention.
      expect(holder.stderr()).toBe('');
      expect(writer.stderr()).toBe('');
      expect(holderExit.code).toBe(0);
      expect(writerExit.code).toBe(0);

      // The writer really waited: it could not write before the holder
      // committed, so its write took at least as long as the lock was held.
      const elapsed = Number(readFileSync(writerResult, 'utf8'));
      expect(elapsed).toBeGreaterThanOrEqual(900);

      // Both writes landed.
      const store = await openStore(dbPath);
      try {
        const ids = store.db.prepare('SELECT id FROM assets ORDER BY id').all() as {
          id: string;
        }[];
        expect(ids.map((row) => row.id)).toEqual(['holder-asset', 'writer-asset']);
      } finally {
        store.close();
      }
    } finally {
      holder.child.kill('SIGKILL');
      writer.child.kill('SIGKILL');
      removeTempDir(dir);
    }
  }, 30_000);
});
