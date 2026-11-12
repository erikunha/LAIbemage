/**
 * Shared helpers for the store's repositories.
 *
 * ## Contracts-first (constitution III)
 *
 * Every repository validates its payload with the Zod schema from
 * `@vision-lens/contracts` BEFORE touching the database. The schema is the
 * first line of defence; the database constraints (NOT NULL, FOREIGN KEY,
 * CHECK) are the second. A payload that the contracts reject never reaches
 * SQLite, and a payload that somehow bypasses the repository is still
 * rejected by the database.
 *
 * ## The "not recorded" sentinel (constitution II)
 *
 * Some contract fields are OPTIONAL (`sessionId` on an annotation or a
 * prediction) while the column that carries them is NOT NULL. Those columns
 * store the empty string `''` as the "not recorded" sentinel.
 *
 * **The sentinel is a storage detail, never a value.** A column that holds
 * the sentinel MUST be read back as `undefined`, so that an entity read from
 * the database is indistinguishable from the entity that was written — and
 * therefore still satisfies its contract schema.
 *
 * This rule is enforced in ONE place, on purpose:
 *
 *  - {@link sentinelText} writes it (an optional field becomes `''`);
 *  - {@link optionalText} reads it back (`''` becomes `undefined`).
 *
 * Every repository that reads a text column goes through {@link optionalText}
 * — never through a raw `?? undefined` — so a new optional column cannot
 * silently reintroduce the leak. The leak is real: a `''` read back as a
 * string makes `PredictionSchema.safeParse()` fail ("Invalid option:
 * expected one of cli|studio|api|mcp|agent").
 */

import type { ZodType, z } from 'zod';
import type { SqliteDatabase } from '../db.js';
import { StoreValidationError } from '../errors.js';

/** A raw row as returned by better-sqlite3. */
export type Row = Record<string, unknown>;

/** A JSON value as stored in a JSON column. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Validates a payload against a contract schema.
 *
 * On failure a {@link StoreValidationError} is thrown, carrying the Zod
 * issues verbatim so a caller can point at the offending field.
 */
export function parseEntity<S extends ZodType>(
  schema: S,
  value: unknown,
  entityName: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
    throw new StoreValidationError(`Invalid ${entityName} payload — ${detail}`, result.error.issues, {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * The "not recorded" sentinel.
 *
 * It is the value stored in a NOT NULL text column whose contract field is
 * optional. It is NEVER a domain value: on the way out it means "absent", on
 * the way back in it MUST become `undefined` again (see {@link optionalText}).
 */
export const NOT_RECORDED = '';

/** Maps `undefined` to `null` for a nullable TEXT column. */
export function nullableText(value: string | undefined): string | null {
  return value ?? null;
}

/** Maps `undefined` to `null` for a nullable INTEGER/REAL column. */
export function nullableNumber(value: number | undefined): number | null {
  return value ?? null;
}

/**
 * Maps an optional contract field to the "not recorded" sentinel of a NOT
 * NULL text column.
 *
 * The counterpart of {@link optionalText}: whatever this writes, that reads
 * back as `undefined`.
 */
export function sentinelText(value: string | undefined): string {
  return value ?? NOT_RECORDED;
}

/**
 * Maps a nullable (or sentinel-bearing) TEXT column back to `undefined`.
 *
 * **The empty string is the "not recorded" sentinel, not a value.** It is
 * mapped to `undefined` here, so an optional field that was never recorded
 * reads back as absent — and the entity still satisfies its contract schema.
 *
 * Every optional text column of every repository goes through this function.
 */
export function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value === NOT_RECORDED ? undefined : value;
}

/** Maps a boolean to SQLite's integer representation. */
export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/** Maps SQLite's integer representation back to a boolean. */
export function intToBool(value: unknown): boolean {
  return value === 1;
}

/**
 * A read-only base for the repositories.
 *
 * It owns nothing but the handle and a small set of query helpers; every
 * repository maps its own rows explicitly (no generic ORM), so the SQL stays
 * readable and the column mapping stays checkable against the contracts.
 */
export abstract class BaseRepository {
  protected constructor(protected readonly db: SqliteDatabase) {}

  /** Runs a query and returns every row. */
  protected allRows(sql: string, params: Record<string, unknown> = {}): Row[] {
    return this.db.prepare(sql).all(params) as Row[];
  }

  /** Runs a query and returns the first row, if any. */
  protected firstRow(sql: string, params: Record<string, unknown> = {}): Row | undefined {
    return this.db.prepare(sql).get(params) as Row | undefined;
  }
}
