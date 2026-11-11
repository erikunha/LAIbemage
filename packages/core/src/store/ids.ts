/**
 * Identity helpers for the Master Vision store (spec 002, plan: "Identity").
 *
 * The contracts fix entity identity as **UUIDv7** (`z.uuidv7()`): time-ordered
 * so that primary-key inserts stay append-mostly and index locality is
 * preserved without a separate sequence column.
 *
 * This module provides two id flavours:
 *
 *  1. {@link newEntityId} — a time-ordered UUIDv7 for freshly created rows.
 *  2. {@link pathHashPlaceholderId} — a **deterministic** UUIDv7-shaped id for
 *     assets whose bytes were never reachable (legacy or remote imports).
 *
 * ## The `unhashed` placeholder rule (constitution II — originals immutable)
 *
 * An `Asset` is content-addressed by the sha256 of its bytes. When those bytes
 * cannot be read (a legacy run pointing at a moved file, a remote path), the
 * asset is stored with `unhashed = 1` and `sha256 = NULL` instead of being
 * dropped (spec 002 edge case: "the importer never fails on missing bytes").
 *
 * Such a row still needs a stable identity, otherwise the same file imported
 * twice would produce two different rows and the store could not deduplicate
 * it. The rule is therefore:
 *
 * > **When `assets.unhashed = 1`, the asset id MUST be the deterministic
 * > path-hash placeholder derived from the asset's absolute path.**
 *
 * The placeholder is `sha256(resolve(path))` truncated to 16 bytes and
 * re-stamped with the UUID version-7 and variant bits, so it is a valid
 * `z.uuidv7()` string (the contracts' id format) while staying a pure
 * function of the path. Re-hashing the file later (spec 004) replaces the
> placeholder with the real content hash — it does not change the row id,
 * because the row id is not the content address.
 *
 * The rule is enforced in the repository layer (`AssetsRepository`), because
 * SQLite cannot recompute a sha256 of a path that lives on the caller's
 * filesystem.
 */

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

/** Formats 16 bytes as a canonical lowercase UUID string. */
function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Stamps the UUID version (7) and variant (RFC 4122) bits onto 16 bytes.
 *
 * Bit-forcing rather than generating keeps the digest bytes intact, which is
 * what makes the path placeholder deterministic.
 */
function stampUuidV7(bytes: Uint8Array): string {
  const stamped = Buffer.from(bytes);
  stamped[6] = (stamped[6]! & 0x0f) | 0x70; // version 7
  stamped[8] = (stamped[8]! & 0x3f) | 0x80; // variant 10xx
  return formatUuid(stamped);
}

/**
 * Creates a fresh time-ordered UUIDv7.
 *
 * The first 48 bits are the Unix epoch milliseconds, so ids sort by creation
 * time as text — which is what keeps the store's primary-key inserts
 * append-mostly.
 */
export function newEntityId(timestampMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestampMs, 0, 6); // 48-bit big-endian epoch milliseconds
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  return formatUuid(bytes);
}

/**
 * Derives the deterministic placeholder id of an asset whose bytes are
 * unreachable.
 *
 * The path is resolved to an absolute path first, so the same file referenced
 * through two relative paths yields the same placeholder. The digest is taken
 * over the POSIX-normalized absolute path so the placeholder does not change
 * when the same tree is checked out on another platform.
 */
export function pathHashPlaceholderId(assetPath: string): string {
  const absolute = path.resolve(assetPath);
  const digest = createHash('sha256').update(absolute.split(path.sep).join('/')).digest();
  return stampUuidV7(digest.subarray(0, 16));
}
