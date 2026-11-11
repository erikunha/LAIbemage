/**
 * Error types of the Master Vision store (spec 002, US2 / US4).
 *
 * The store distinguishes four failure classes, because they call for
 * different operator responses:
 *
 *  - {@link StoreUnavailableError} — the optional native driver
 *    (`better-sqlite3`) could not be loaded. Operator action: install it.
 *  - {@link StoreValidationError} — a payload was rejected at the repository
 *    boundary by the contracts (`@master-vision/contracts`) or by the
 *    repository's own link rules. Operator action: fix the payload; the row
 *    was NOT written.
 *  - {@link StoreMigrationError} — the schema history is inconsistent (edited
 *    migration, missing rollback script, missing migration file, gap or
 *    out-of-order history). Operator action: restore the migration files or
 *    migrate deliberately.
 *  - {@link StoreConsistencyError} — the stored data contradicts an invariant
 *    the store guarantees (a chain that points nowhere, a row without its
 *    model version). Operator action: the database is damaged; inspect it.
 *
 * A database-level constraint violation (NOT NULL, FOREIGN KEY, CHECK) is NOT
 * wrapped: it surfaces as the driver's own `SqliteError`, whose `code`
 * (`SQLITE_CONSTRAINT_NOTNULL`, `SQLITE_CONSTRAINT_FOREIGNKEY`, …) is part of
 * the store's contract with its callers.
 */

/** The optional native SQLite driver could not be loaded. */
export class StoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreUnavailableError';
  }
}

/** A payload was rejected by the contracts before it reached the database. */
export class StoreValidationError extends Error {
  /** The Zod issues, verbatim, so callers can point at the offending field. */
  readonly issues: readonly unknown[];

  constructor(message: string, issues: readonly unknown[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreValidationError';
    this.issues = issues;
  }
}

/** The migration history is inconsistent or a rollback script is missing. */
export class StoreMigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreMigrationError';
  }
}

/**
 * The stored data contradicts an invariant the store guarantees.
 *
 * Unlike {@link StoreValidationError} — which means "the caller sent
 * something the store refuses" — this means "the database itself is
 * inconsistent": a chain that points nowhere, a prediction without its model
 * version. The store must fail loudly rather than return a half-built
 * answer.
 */
export class StoreConsistencyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreConsistencyError';
  }
}

/** Type guard for {@link StoreValidationError}. */
export function isStoreValidationError(error: unknown): error is StoreValidationError {
  return error instanceof StoreValidationError;
}

/** Type guard for {@link StoreUnavailableError}. */
export function isStoreUnavailableError(error: unknown): error is StoreUnavailableError {
  return error instanceof StoreUnavailableError;
}

/** Type guard for {@link StoreMigrationError}. */
export function isStoreMigrationError(error: unknown): error is StoreMigrationError {
  return error instanceof StoreMigrationError;
}

/** Type guard for {@link StoreConsistencyError}. */
export function isStoreConsistencyError(error: unknown): error is StoreConsistencyError {
  return error instanceof StoreConsistencyError;
}
