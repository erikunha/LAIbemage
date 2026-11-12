/**
 * The Vision Lens store: opening the SQLite database (spec 002, US2).
 *
 * ## Why SQLite, and why here
 *
 * ADR-007 (local-first): the platform runs entirely on one machine before it
 * runs anywhere else. The store is the local metadata spine that every later
 * spec (004 data, 005 search, 006 evaluation) reads and writes through; JSON
 * caches stop being the source of truth here.
 *
 * This module is **not** the reporter's SQLite output
 * (`packages/core/src/reporter/sqlite.ts` writes a per-run artifact with a
 * different schema). The store owns the domain schema; the reporter keeps
 * producing run artifacts that the importer (spec 002, task 4) reads.
 *
 * ## Optional dependency
 *
 * `better-sqlite3` is a NATIVE module and is declared as an **optional
 * dependency** of `@vision-lens/core`. It must never be a hard import:
 * the import is dynamic and guarded, so a machine without the native binding
 * gets an actionable error instead of a module-resolution stack trace. The
 * guard is the same pattern the reporter uses (`reporter/sqlite.ts`), plus a
 * seam (`DriverFactory`) so the guard can be tested without uninstalling the
 * package.
 *
 * ## Pragmas and their operational consequences
 *
 * | Pragma | Value | Consequence |
 * |---|---|---|
 * | `journal_mode` | `WAL` | Readers do not block the writer and the writer does not block readers. Crash recovery depends on WAL: an interrupted write leaves the last committed state intact (spec 002, SC-004). WAL creates `-wal` / `-shm` sidecar files next to the database. |
 * | `busy_timeout` | `5000` | A contending writer waits up to 5 s for the lock instead of failing immediately with `SQLITE_BUSY`. It covers SHORT contention only — it is not a queue and it does not make concurrent writers safe (see below). |
 * | `foreign_keys` | `ON` | Foreign keys are ENFORCED, not decorative. `ON DELETE` behaviour is defined per relation in `migrations/0001_init.sql`. Note that SQLite only honours this pragma per connection, so every connection must open the store through this module. |
 * | `synchronous` | `NORMAL` | With WAL, `NORMAL` is crash-safe against process death (the WAL is still written) but can lose the most recent transactions on a **power / OS crash**. `FULL` would fsync every commit at a large throughput cost. This is the deliberate trade-off of a local-first, single-writer store; a store that must survive power loss should open with `synchronous = FULL`. |
 *
 * ## The single-writer assumption
 *
 * **One writer process at a time.** The store assumes a single-user,
 * single-process application (spec 002 assumption: "Single-user
 * single-process"; the same constraint is documented for the API service in
 * spec 009). `busy_timeout` absorbs the brief contention that happens when a
 * background process (a CLI run, a studio session) overlaps with another for
 * a few hundred milliseconds — it does **not** make two long-running writers
 * safe: the second writer will either wait up to 5 s and then fail with
 * `SQLITE_BUSY`, or interleave logically unrelated transactions. Callers that
 * need real concurrency must serialise writes themselves (the concurrency
 * test in `tests/store/concurrency.test.ts` exercises exactly this path).
 *
 * ## The default path is a proposal, not a decision
 *
 * {@link defaultStorePath} follows ADR-007 (local-first): `VISION_LENS_HOME`
 * when set, otherwise `~/.vision-lens`, with the database in `store.db`.
 * The product rename fixed the NAME of the home directory (`~/.vision-lens`);
 * **the LOCATION is still a PROPOSAL pending maintainer confirmation** — it
 * is not yet pinned by an ADR. Every function in the store accepts an
 * explicit path, and every test uses an explicit temporary path: the home
 * directory is never touched by the test suite.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { StoreUnavailableError } from './errors.js';

/** The better-sqlite3 database handle (types only — never a runtime import). */
export type SqliteDatabase = import('better-sqlite3').Database;

/** The better-sqlite3 constructor (types only — never a runtime import). */
export type SqliteDatabaseConstructor = new (filename: string) => SqliteDatabase;

/**
 * A factory that resolves the native driver.
 *
 * Injecting a factory is how the optional-dependency guard is tested without
 * uninstalling `better-sqlite3`: a test can hand in a factory that throws and
 * assert the actionable error, or hand in a fake driver.
 */
export type DriverFactory = () => SqliteDatabaseConstructor | Promise<SqliteDatabaseConstructor>;

/** Options accepted by {@link openStore}. */
export interface OpenStoreOptions {
  /**
   * Resolves the native driver. Defaults to the guarded dynamic import of
   * `better-sqlite3`.
   */
  readonly driver?: DriverFactory;
  /** Milliseconds a blocked writer waits for the lock. Defaults to 5000. */
  readonly busyTimeoutMs?: number;
  /** `synchronous` pragma value. Defaults to `NORMAL` (see the module docblock). */
  readonly synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  /** Create the parent directory when missing. Defaults to `true`. */
  readonly createParentDir?: boolean;
}

/** An open store: the database handle plus the path it was opened from. */
export interface Store {
  /** Absolute path of the SQLite file. */
  readonly path: string;
  /** The native database handle. */
  readonly db: SqliteDatabase;
  /** Closes the handle. Safe to call twice. */
  close(): void;
}

/**
 * The default location of the store file.
 *
 * The path NAME is settled; the LOCATION is a PROPOSAL pending maintainer
 * confirmation (see the module docblock).
 */
export function defaultStorePath(): string {
  const home = process.env['VISION_LENS_HOME'] ?? path.join(homedir(), '.vision-lens');
  return path.join(home, 'store.db');
}

/**
 * The default driver factory: a guarded dynamic import of `better-sqlite3`.
 *
 * The import is dynamic on purpose — `better-sqlite3` is a native optional
 * dependency and must never be a hard (static) import of this module.
 */
export const defaultDriverFactory: DriverFactory = async () => {
  try {
    const mod = (await import('better-sqlite3')) as {
      default: SqliteDatabaseConstructor;
    };
    return mod.default;
  } catch (error) {
    throw new StoreUnavailableError(
      'better-sqlite3 is not installed (it is an optional dependency of @vision-lens/core). ' +
        'Run `pnpm add better-sqlite3` (in this workspace: `pnpm add -w --save-optional better-sqlite3`) and try again.',
      { cause: error },
    );
  }
};

/**
 * Opens the store at `storePath` with the pragmas the domain schema relies
 * on.
 *
 * The parent directory is created when missing, so the default path works on
 * a fresh machine.
 */
export async function openStore(
  storePath: string,
  options: OpenStoreOptions = {},
): Promise<Store> {
  const driverFactory = options.driver ?? defaultDriverFactory;

  let Driver: SqliteDatabaseConstructor;
  try {
    Driver = await driverFactory();
  } catch (error) {
    if (error instanceof StoreUnavailableError) throw error;
    // A driver factory that fails for any reason means the native module is
    // unusable; surface the same actionable message with the cause attached.
    throw new StoreUnavailableError(
      'better-sqlite3 is not installed (it is an optional dependency of @vision-lens/core). ' +
        'Run `pnpm add better-sqlite3` (in this workspace: `pnpm add -w --save-optional better-sqlite3`) and try again.',
      { cause: error },
    );
  }

  const absolute = path.resolve(storePath);
  if (options.createParentDir !== false) {
    mkdirSync(path.dirname(absolute), { recursive: true });
  }

  const db = new Driver(absolute);

  // WAL first: the journal mode cannot change inside a transaction and is the
  // precondition for the crash-recovery guarantee (SC-004).
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  db.pragma('foreign_keys = ON');
  db.pragma(`synchronous = ${options.synchronous ?? 'NORMAL'}`);

  return {
    path: absolute,
    db,
    close(): void {
      if (db.open) db.close();
    },
  };
}
