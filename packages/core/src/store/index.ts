/**
 * The Vision Lens store (spec 002, US2 / US4).
 *
 * The store is the local metadata spine of the platform: a SQLite database
 * with the 14 domain entities, the repositories that write them, the
 * provenance and lineage invariants that make them auditable, and the
 * migration protocol that keeps the schema reproducible.
 *
 * ## The invariants this module exists to enforce
 *
 *  - **Prediction ≠ Annotation** (constitution II): separate contracts,
 *    separate tables, and database CHECK constraints that keep a model
 *    output from ever being recorded as a human label.
 *  - **Provenance is mandatory**: every label carries who produced it,
 *    through which surface, in which session and when. The database makes
 *    the provenance columns NOT NULL and CHECK-constrained, so an actor
 *    reference or a surface can never be empty. The two fields the CONTRACTS
 *    leave optional (`sessionId` on an annotation and on a prediction) live
 *    in NOT NULL columns that carry the empty string as the "not recorded"
 *    sentinel — a storage detail that is read back as `undefined`, never as
 *    an empty string (see the sentinel rule in
 *    `repositories/base.ts`).
 *  - **Labels are never mutated**: a correction is a new row that supersedes
 *    the old one. No repository exposes an "update label" or an "update
 *    provenance" method, and the supersede pointer is always set BY the
 *    repository, never by the caller.
 *  - **Lineage is structural**: a derived artifact cannot exist without its
 *    source assets, its transform and its transform fingerprint.
 *  - **Originals are immutable**: the asset row is the identity of a file
 *    that already exists; nothing edits it.
 *
 * ## Shape of the module
 *
 * | File | Responsibility |
 * |---|---|
 * | `db.ts` | opening the database, the pragmas, the optional-dependency guard |
 * | `migrations/` | the SQL migrations and their rollback scripts |
 * | `migrate.ts` | the hash-recorded migration runner |
 * | `repositories/` | one repository per aggregate |
 * | `import/` | the legacy-run importer (spec 002, task 4) |
 * | `lineage.ts` | the auditor walk |
 * | `ids.ts`, `clock.ts`, `json.ts`, `errors.ts` | shared primitives |
 *
 * The store never touches the user's home directory on its own: every
 * function takes an explicit path, and `defaultStorePath()` is a documented
 * proposal pending maintainer confirmation.
 */

import { openStore, type OpenStoreOptions, type Store } from './db.js';
import { applyMigrations, type MigrationOptions } from './migrate.js';

export {
  defaultDriverFactory,
  defaultStorePath,
  openStore,
} from './db.js';
export type {
  DriverFactory,
  OpenStoreOptions,
  SqliteDatabase,
  SqliteDatabaseConstructor,
  Store,
} from './db.js';

export {
  applyMigrations,
  defaultMigrationsDir,
  migrateStore,
  readMigrations,
  rollbackMigrations,
  rollbackStore,
} from './migrate.js';
export type {
  MigrationDefinition,
  MigrationOptions,
  MigrationReport,
} from './migrate.js';

export {
  StoreConsistencyError,
  StoreMigrationError,
  StoreUnavailableError,
  StoreValidationError,
  isStoreConsistencyError,
  isStoreMigrationError,
  isStoreUnavailableError,
  isStoreValidationError,
} from './errors.js';

export { isStrictlyAfter, nextTimestamp } from './clock.js';
export { newEntityId, pathHashPlaceholderId } from './ids.js';
export { fromJsonColumn, toJsonColumn, toRequiredJsonColumn } from './json.js';

export {
  listAssetsOfSnapshot,
  listSamplesOfSnapshot,
  walkArtifactLineage,
  walkPredictionLineage,
} from './lineage.js';
export type { ArtifactLineage, PredictionLineage } from './lineage.js';

export * from './repositories/index.js';

/**
 * The legacy-run importer (spec 002, US2 / task 4).
 *
 * `importLegacyRun` reads a legacy analysis run and writes the domain
 * entities into the store, idempotently and without ever mutating an
 * original.
 */
export * from './import/index.js';

/**
 * Opens the store and applies the pending migrations in one call.
 *
 * The convenience most callers want: a migrated store, ready to use.
 */
export async function openMigratedStore(
  storePath: string,
  options: OpenStoreOptions & MigrationOptions = {},
): Promise<Store> {
  const store = await openStore(storePath, options);
  try {
    applyMigrations(store.db, options);
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}
