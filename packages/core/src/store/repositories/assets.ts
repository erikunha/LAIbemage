/**
 * Assets: the original, immutable media files (spec 002, US2 / US4).
 *
 * ## The immutability rule (constitution II)
 *
 * An asset row is the identity of a file that already exists on disk. The
 * repository offers **no update method**: the bytes of an original never
 * change, so neither does its row. Everything derived from an asset
 * (thumbnail, embedding, mask) lives in its own row and points back here.
 *
 * The one mutation the store knows about is the `unhashed → hashed`
 * transition performed by the re-hasher of spec 004, and it is deliberately
 * NOT exposed here: it changes the content address of a row, which is a
 * deliberate, auditable act that belongs to its own repository method in 004.
 */

import { AssetSchema, type Asset } from '@vision-lens/contracts';
import type { SqliteDatabase } from '../db.js';
import { StoreValidationError } from '../errors.js';
import { pathHashPlaceholderId } from '../ids.js';
import { fromJsonColumn, toJsonColumn } from '../json.js';
import {
  BaseRepository,
  boolToInt,
  intToBool,
  nullableNumber,
  nullableText,
  optionalText,
  parseEntity,
  type JsonValue,
  type Row,
} from './base.js';

/** The `assets` table. */
export class AssetsRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /**
   * Inserts an asset.
   *
   * The `unhashed` identity rule is enforced here (SQLite cannot recompute a
   * hash of a path that lives on the caller's filesystem):
   *
   *  - `unhashed = true` ⇒ no `sha256`, a `path`, and the id MUST be the
   *    deterministic path-hash placeholder.
   *  - `unhashed = false` ⇒ a `sha256` is present.
   */
  insert(asset: Asset): Asset {
    const entity = parseEntity(AssetSchema, asset, 'Asset');
    this.assertIdentityRule(entity);

    this.db
      .prepare(
        `INSERT INTO assets (
           id, sha256, kind, bytes, width, height, exif_sanitized_json,
           capture_session_id, unhashed, path, created_at, updated_at
         ) VALUES (
           @id, @sha256, @kind, @bytes, @width, @height, @exif_sanitized_json,
           @capture_session_id, @unhashed, @path, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        sha256: nullableText(entity.sha256),
        kind: entity.kind,
        bytes: nullableNumber(entity.bytes),
        width: nullableNumber(entity.width),
        height: nullableNumber(entity.height),
        exif_sanitized_json: toJsonColumn(entity.exifSanitizedJson),
        capture_session_id: nullableText(entity.captureSessionId),
        unhashed: boolToInt(entity.unhashed),
        path: nullableText(entity.path),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads an asset by id. */
  getById(id: string): Asset | undefined {
    const row = this.firstRow('SELECT * FROM assets WHERE id = @id', { id });
    return row ? toAsset(row) : undefined;
  }

  /** Reads a hashed asset by its content address. */
  findBySha256(sha256: string): Asset | undefined {
    const row = this.firstRow('SELECT * FROM assets WHERE sha256 = @sha256', { sha256 });
    return row ? toAsset(row) : undefined;
  }

  /** Reads an asset by its path (used to find a placeholder id). */
  findByPath(assetPath: string): Asset | undefined {
    const row = this.firstRow('SELECT * FROM assets WHERE path = @path', { path: assetPath });
    return row ? toAsset(row) : undefined;
  }

  /** Every asset captured in one session. */
  listByCaptureSession(captureSessionId: string): Asset[] {
    return this.allRows('SELECT * FROM assets WHERE capture_session_id = @capture_session_id ORDER BY created_at', {
      capture_session_id: captureSessionId,
    }).map(toAsset);
  }

  /** The deterministic placeholder id an unhashed asset must carry. */
  static placeholderIdFor(assetPath: string): string {
    return pathHashPlaceholderId(assetPath);
  }

  private assertIdentityRule(entity: Asset): void {
    if (entity.unhashed) {
      if (entity.sha256 !== undefined) {
        throw new StoreValidationError(
          'An unhashed asset must not carry a sha256: the content address is unknown.',
          [],
        );
      }
      if (!entity.path) {
        throw new StoreValidationError(
          'An unhashed asset must carry the path it was derived from.',
          [],
        );
      }
      const expected = pathHashPlaceholderId(entity.path);
      if (entity.id !== expected) {
        throw new StoreValidationError(
          `An unhashed asset must use the deterministic path-hash placeholder id '${expected}'.`,
          [],
        );
      }
      return;
    }
    if (entity.sha256 === undefined) {
      throw new StoreValidationError('A hashed asset must carry its sha256.', []);
    }
  }
}

/** Maps an `assets` row to the contract entity. */
export function toAsset(row: Row): Asset {
  return {
    id: row['id'] as string,
    sha256: optionalText(row['sha256']),
    kind: row['kind'] as Asset['kind'],
    bytes: (row['bytes'] as number | null) ?? undefined,
    width: (row['width'] as number | null) ?? undefined,
    height: (row['height'] as number | null) ?? undefined,
    exifSanitizedJson: fromJsonColumn<JsonValue>(row['exif_sanitized_json'] as string | null),
    captureSessionId: optionalText(row['capture_session_id']),
    unhashed: intToBool(row['unhashed']),
    path: optionalText(row['path']),
    createdAt: row['created_at'] as string,
  };
}
