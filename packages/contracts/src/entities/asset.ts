import { z } from 'zod';
import { EntityIdSchema, JsonValueSchema, Sha256Schema, TimestampSchema, strict } from '../base.js';

/**
 * An original, immutable media file.
 *
 * Constitutional invariant (II): the original media file is immutable —
 * everything derived from it records its own lineage instead of mutating it.
 *
 * `unhashed` is the escape hatch for assets whose bytes were never reachable
 * (legacy or remote imports): the asset is flagged rather than dropped, and
 * spec 004 re-hashes it. `sha256` is therefore optional exactly when
 * `unhashed` is true — and BOTH directions are enforced here:
 *
 *  - `unhashed = true` ⇒ no `sha256` (the content address is unknown, and a
 *    digest that was never computed must not be invented);
 *  - `unhashed = false` ⇒ a `sha256` (a hashed asset without its digest is
 *    not addressable).
 *
 * The schema is the first line of defence; the database CHECK
 * (`(unhashed = 1 AND sha256 IS NULL) OR (unhashed = 0 AND sha256 IS NOT NULL)`)
 * is the second.
 */
export const AssetSchema = strict({
  id: EntityIdSchema,
  sha256: Sha256Schema.optional(),
  kind: z.enum(['image', 'video', 'audio', 'other']),
  bytes: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  exifSanitizedJson: JsonValueSchema.optional(),
  captureSessionId: EntityIdSchema.optional(),
  unhashed: z.boolean(),
  path: z.string().min(1).optional(),
  createdAt: TimestampSchema,
})
  .superRefine((asset, ctx) => {
    if (asset.unhashed && asset.sha256 !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sha256'],
        message:
          'An unhashed asset must not carry a sha256: the content address is unknown. ' +
          '`sha256` is optional exactly when `unhashed` is true.',
      });
    }
    if (!asset.unhashed && asset.sha256 === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sha256'],
        message:
          'A hashed asset must carry its sha256: without it the asset is not addressable. ' +
          '`sha256` is optional exactly when `unhashed` is true.',
      });
    }
  })
  .describe('An original, immutable media file.');

export type Asset = z.infer<typeof AssetSchema>;
