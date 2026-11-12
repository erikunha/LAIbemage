/* global process, setInterval */

/**
 * Child-process fixture for the store's crash and concurrency tests.
 *
 * It opens a store the way the application does (WAL, busy timeout, foreign
 * keys), applies the REAL init migration when the database is empty (so the
 * child and the parent always agree on the schema), and then runs one of two
 * modes:
 *
 *   crash   commit a row, start a transaction, write a row, signal the
 *           parent and BLOCK — the parent kills it with SIGKILL.
 *   hold    start a transaction, write a row, signal the parent, sleep, and
 *           commit — used to create real write contention.
 *   write   wait for the `hold` child's signal, then write a row and record
 *           how long the write had to wait for the lock.
 *
 * Usage: node store-child.mjs <mode> <dbPath> <signalFile> [resultFile] [waitForFile]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const [mode, dbPath, signalFile, resultFile, waitForFile] = process.argv.slice(2);

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(here, '..', '..', 'src', 'store', 'migrations', '0001_init.sql');

/** Opens the database with the store's pragmas. */
function open() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  if (!existsSync(migrationPath)) {
    throw new Error(`migration file not found: ${migrationPath}`);
  }
  const hasAssets = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'")
    .get();
  if (!hasAssets) {
    try {
      db.exec(readFileSync(migrationPath, 'utf8'));
    } catch (error) {
      // Another process may have bootstrapped the schema concurrently (the
      // concurrency test starts two children at the same time). That is not
      // an error: the schema exists either way.
      const alreadyThere = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'")
        .get();
      if (!alreadyThere) throw error;
    }
  }
  return db;
}

/** Writes one asset row. */
function insertAsset(db, id) {
  db.prepare(
    `INSERT INTO assets (id, sha256, kind, unhashed, path, created_at, updated_at)
     VALUES (?, ?, 'image', 0, ?, ?, ?)`,
  ).run(id, 'c'.repeat(64), `/tmp/${id}.jpg`, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
}

function signal(name) {
  writeFileSync(signalFile, name);
}

/** Synchronous sleep (Atomics.wait) — the child must not yield the event loop. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (mode === 'crash') {
  const db = open();
  insertAsset(db, 'committed-asset');
  db.exec('BEGIN IMMEDIATE');
  insertAsset(db, 'uncommitted-asset');
  signal('in-transaction');
  // Block forever: the parent kills this process with SIGKILL.
  setInterval(() => {}, 1000);
} else if (mode === 'hold') {
  const db = open();
  db.exec('BEGIN IMMEDIATE');
  insertAsset(db, 'holder-asset');
  signal('locked');
  sleep(1200);
  db.exec('COMMIT');
  db.close();
} else if (mode === 'write') {
  const db = open();
  // Wait until the holder owns the write lock (the holder's signal file).
  const gate = waitForFile ?? signalFile;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !existsSync(gate)) {
    sleep(20);
  }
  const started = Date.now();
  insertAsset(db, 'writer-asset');
  const elapsed = Date.now() - started;
  if (resultFile) writeFileSync(resultFile, String(elapsed));
  db.close();
} else {
  throw new Error(`unknown mode: ${mode}`);
}
