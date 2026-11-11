/**
 * The migration runner of the Master Vision store (spec 002, task 3.1).
 *
 * ## Protocol
 *
 *  1. Migrations are plain `.sql` files in `migrations/`, one per version,
 *     named `<id>_<name>.sql` (`0001_init.sql`). Each migration has a paired
 *     rollback file `<id>_<name>.rollback.sql`.
 *  2. `schema_migrations(id, hash, applied_at)` is the ledger. `hash` is the
 *     sha256 of the migration file's bytes; `applied_at` is the ISO timestamp
 *     of the application.
 *  3. Pending migrations are applied in ascending id order, EACH INSIDE ITS
 *     OWN TRANSACTION: a migration either lands completely or not at all.
 *  4. **Edited history is refused.** When an already-applied migration's file
 *     no longer hashes to the recorded value, the runner aborts with an error
 *     naming the migration and both hashes. Silently re-running a changed
 *     migration is how a store ends up with a schema nobody can reproduce.
 *  5. **A broken sequence is refused.** The known migration ids (recorded in
 *     the ledger + present on disk) must form a contiguous sequence, and no
 *     pending migration may have a lower id than an already-applied one. A
 *     missing predecessor (`0002` vanished while `0003` is on disk) or a
 *     late arrival (`0000` shows up after `0002` was applied) is an error
 *     with a clear message — NOT a raw driver error and never a silent
 *     skip.
 *  6. `rollbackMigrations(db, targetVersion)` applies the paired rollback
 *     files in reverse order and removes their ledger rows. A missing
 *     rollback script is an error, not a warning: rollback scripts must be
 *     real.
 *
 * ## The destructive-change rule
 *
 * > **A migration that drops or rewrites data requires a MAJOR
 * > `CONTRACTS_VERSION` bump.**
 *
 * Additive changes (a new table, a new nullable column, a new index) are
 * fine under a minor bump. Anything that drops a column, narrows a
 * constraint or rewrites stored rows changes the meaning of the data that
 * already exists, and the contracts are the versioned description of that
 * meaning — so the version must say so. The runner does not enforce this
 * automatically (it cannot know the intent of a migration); it is the
 * discipline the reviewer applies, and it is mirrored by the contracts'
 * version guard (`packages/contracts/src/version-guard.ts`).
 *
 * ## Where the migration files live
 *
 * The `.sql` files live next to this module (`./migrations/`). The package
 * build copies them into `dist/store/migrations/` so the compiled store can
 * still find them at runtime; in development (vitest / tsx) the source
 * directory is used directly. Tests that need a tampered copy pass an
 * explicit `migrationsDir` — the repository's own SQL files are never
 * modified.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type SqliteDatabase } from './db.js';
import { StoreMigrationError } from './errors.js';

/** A migration file discovered on disk. */
export interface MigrationDefinition {
  /** Zero-padded numeric id, e.g. `0001`. */
  readonly id: string;
  /** Human-readable name, e.g. `init`. */
  readonly name: string;
  /** Absolute path of the `.sql` file. */
  readonly filePath: string;
  /** Absolute path of the paired `.rollback.sql` file. */
  readonly rollbackPath: string;
  /** sha256 of the migration file's bytes (hex). */
  readonly hash: string;
  /** The SQL body. */
  readonly sql: string;
}

/** What the runner did. */
export interface MigrationReport {
  /** Ids applied by this call, in application order. */
  readonly applied: readonly string[];
  /** Ids that were already applied and verified. */
  readonly alreadyApplied: readonly string[];
  /** The highest migration id now applied, or `null` for an empty ledger. */
  readonly version: string | null;
}

/** Options accepted by the runner. */
export interface MigrationOptions {
  /**
   * Directory holding the migration files. Defaults to the `migrations/`
   * directory next to this module.
   */
  readonly migrationsDir?: string;
}

/** The DDL that bootstraps the ledger itself. */
const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    hash       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

/**
 * The directory holding the migration files.
 *
 * Resolved relative to this module so it works both from `src/` (tests) and
 * from `dist/` (the build copies the `.sql` files across).
 */
export function defaultMigrationsDir(): string {
  return path.join(fileURLToPath(new URL('.', import.meta.url)), 'migrations');
}

/**
 * Reads and hashes every migration file in `dir`.
 *
 * Rollback files are not migrations: they are excluded from the list.
 */
export function readMigrations(dir: string = defaultMigrationsDir()): MigrationDefinition[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new StoreMigrationError(`Cannot read the migrations directory '${dir}'.`, { cause: error });
  }

  const definitions: MigrationDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.sql')) continue;
    if (entry.endsWith('.rollback.sql')) continue;
    const match = /^(\d+)_([^.]+)\.sql$/.exec(entry);
    if (!match) {
      throw new StoreMigrationError(
        `Migration file '${entry}' does not follow the '<id>_<name>.sql' naming convention.`,
      );
    }
    const [, id, name] = match;
    const filePath = path.join(dir, entry);
    const bytes = readFileSync(filePath);
    definitions.push({
      id: id!,
      name: name!,
      filePath,
      rollbackPath: path.join(dir, `${id}_${name}.rollback.sql`),
      hash: createHash('sha256').update(bytes).digest('hex'),
      sql: bytes.toString('utf8'),
    });
  }

  return definitions.sort((a, b) => compareIds(a.id, b.id));
}

/** Compares two zero-padded migration ids numerically, then lexically. */
function compareIds(a: string, b: string): number {
  const numeric = Number(a) - Number(b);
  if (numeric !== 0) return numeric;
  return a.localeCompare(b);
}

/** Reads the ledger into a map of id → recorded hash. */
function readLedger(db: SqliteDatabase): Map<string, string> {
  db.exec(LEDGER_DDL);
  const rows = db.prepare('SELECT id, hash FROM schema_migrations').all() as {
    id: string;
    hash: string;
  }[];
  return new Map(rows.map((row) => [row.id, row.hash]));
}

/**
 * Refuses a migration history that is out of order or has a gap.
 *
 * Two defects are detected here, both of which used to slip through:
 *
 *  - **Out of order**: a pending migration has a LOWER id than a migration
 *    that was already applied. Applying it now would run an old migration on
 *    top of a newer schema — the driver would fail with a raw `SqliteError`
 *    ("table already exists") or, worse, succeed and corrupt the schema.
 *  - **Gap**: the known ids (recorded in the ledger + present on disk) do not
 *    form a contiguous sequence. A never-applied migration whose file is
 *    missing (`0002` vanished while `0003` is on disk) used to be skipped
 *    silently, leaving the store with a schema nobody can reproduce.
 *
 * Both raise a {@link StoreMigrationError} with the offending ids named.
 */
function assertHistoryIsSequential(
  migrations: readonly MigrationDefinition[],
  ledger: ReadonlyMap<string, string>,
  dir: string,
): void {
  const appliedIds = [...ledger.keys()].sort(compareIds);
  const highestApplied = appliedIds[appliedIds.length - 1];

  if (highestApplied !== undefined) {
    const late = migrations
      .filter((migration) => !ledger.has(migration.id))
      .map((migration) => migration.id)
      .find((id) => compareIds(id, highestApplied) < 0);
    if (late !== undefined) {
      throw new StoreMigrationError(
        `Migration '${late}' has a lower id than the already-applied migration ` +
          `'${highestApplied}'. Applying it now would run an old migration on top of a ` +
          `newer schema. The migration history is out of order; restore '${dir}' to the ` +
          'state the ledger was written against.',
      );
    }
  }

  const known = new Set<number>();
  for (const id of [...appliedIds, ...migrations.map((migration) => migration.id)]) {
    known.add(Number(id));
  }
  const ids = [...known].sort((a, b) => a - b);
  const highest = ids[ids.length - 1];
  if (highest === undefined) return;

  const width = Math.max(...[...known].map((id) => String(id).length), 4);
  for (let candidate = 1; candidate <= highest; candidate += 1) {
    if (known.has(candidate)) continue;
    const missing = String(candidate).padStart(width, '0');
    throw new StoreMigrationError(
      `Migration '${missing}' is missing from the history of '${dir}': the known ` +
        `migrations are ${ids.map((id) => String(id).padStart(width, '0')).join(', ')}. ` +
        'A migration that was never applied cannot be skipped silently — restore the ' +
        'missing file or recreate the database.',
    );
  }
}

/**
 * Applies every pending migration, in order, each in its own transaction.
 *
 * Throws {@link StoreMigrationError} when the ledger disagrees with the files
 * on disk (an edited migration, a recorded migration whose file vanished, an
 * out-of-order or gapped history).
 */
export function applyMigrations(
  db: SqliteDatabase,
  options: MigrationOptions = {},
): MigrationReport {
  const dir = options.migrationsDir ?? defaultMigrationsDir();
  const migrations = readMigrations(dir);
  const ledger = readLedger(db);

  // History check first: a tampered file must abort the run BEFORE any
  // migration is applied, so a broken history never gets a fresh migration
  // bolted on top of it.
  for (const [id, recordedHash] of ledger) {
    const definition = migrations.find((candidate) => candidate.id === id);
    if (!definition) {
      throw new StoreMigrationError(
        `Migration '${id}' is recorded as applied but its file is missing from '${dir}'. ` +
          'The migration history is broken; restore the file or recreate the database.',
      );
    }
    if (definition.hash !== recordedHash) {
      throw new StoreMigrationError(
        `Migration '${id}' (${definition.name}) was edited after it was applied. ` +
          `Recorded hash: ${recordedHash}; current hash: ${definition.hash}. ` +
          'Refusing to run: edited migration history is not reproducible.',
      );
    }
  }

  // Sequence check: a gapped or out-of-order history is refused BEFORE any
  // migration runs, so the runner never applies a migration out of order.
  assertHistoryIsSequential(migrations, ledger, dir);

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    if (ledger.has(migration.id)) {
      alreadyApplied.push(migration.id);
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, hash, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.hash,
        new Date().toISOString(),
      );
    });
    apply.immediate();
    applied.push(migration.id);
  }

  const version = migrations.length > 0 ? migrations[migrations.length - 1]!.id : null;
  return { applied, alreadyApplied, version };
}

/**
 * Rolls the schema back to `targetVersion`.
 *
 * Every migration with an id greater than `targetVersion` is rolled back with
 * its paired rollback file, in descending id order, each in its own
 * transaction. `targetVersion = '0000'` rolls the schema back completely
 * (the ledger itself is kept).
 */
export function rollbackMigrations(
  db: SqliteDatabase,
  targetVersion: string,
  options: MigrationOptions = {},
): MigrationReport {
  const dir = options.migrationsDir ?? defaultMigrationsDir();
  const migrations = readMigrations(dir);
  const ledger = readLedger(db);

  const pending = migrations
    .filter((migration) => compareIds(migration.id, targetVersion) > 0)
    .sort((a, b) => compareIds(b.id, a.id)); // reverse order

  const applied: string[] = [];

  for (const migration of pending) {
    if (!ledger.has(migration.id)) continue;
    let rollbackSql: string;
    try {
      rollbackSql = readFileSync(migration.rollbackPath, 'utf8');
    } catch (error) {
      throw new StoreMigrationError(
        `Cannot roll back migration '${migration.id}' (${migration.name}): its rollback script ` +
          `'${migration.rollbackPath}' is missing.`,
        { cause: error },
      );
    }
    const rollback = db.transaction(() => {
      db.exec(rollbackSql);
      db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(migration.id);
    });
    rollback.immediate();
    applied.push(migration.id);
  }

  const remaining = readLedger(db);
  const version =
    remaining.size === 0 ? null : [...remaining.keys()].sort(compareIds)[remaining.size - 1]!;

  return { applied, alreadyApplied: [...remaining.keys()].sort(compareIds), version };
}

/**
 * Opens the store at `storePath` and applies the pending migrations.
 *
 * Convenience wrapper for callers that do not hold a database handle yet.
 */
export async function migrateStore(
  storePath: string,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const store = await openStore(storePath);
  try {
    return applyMigrations(store.db, options);
  } finally {
    store.close();
  }
}

/**
 * Opens the store at `storePath` and rolls the schema back to
 * `targetVersion`.
 */
export async function rollbackStore(
  storePath: string,
  targetVersion: string,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const store = await openStore(storePath);
  try {
    return rollbackMigrations(store.db, targetVersion, options);
  } finally {
    store.close();
  }
}
