import { z } from 'zod';
import { EntityIdSchema, FingerprintSchema, TimestampSchema, strict } from '../base.js';

/**
 * One category of a taxonomy.
 *
 * The description is part of the contract, not decoration: constitution IV
 * requires the fingerprint to cover the *whole* category object, descriptions
 * included, because changing only a description changes the model prompt and
 * therefore the result.
 */
export const OntologyCategorySchema = strict({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
}).describe('One category of a taxonomy.');

/**
 * An immutable version of the label taxonomy.
 *
 * `fingerprint` is the full-config fingerprint of this taxonomy (descriptions
 * included), so two taxonomies that differ only in a description have
 * different fingerprints and cannot be silently compared. It is pinned to the
 * `fp2:<16 hex>` shape the package's own `fingerprintV2` produces, so a
 * taxonomy can never be keyed by a name or a legacy hash.
 */
export const OntologyVersionSchema = strict({
  id: EntityIdSchema,
  version: z.string().min(1),
  categories: z.array(OntologyCategorySchema),
  fingerprint: FingerprintSchema,
  parentId: EntityIdSchema.optional(),
  createdAt: TimestampSchema,
}).describe('An immutable version of the label taxonomy.');

export type OntologyCategory = z.infer<typeof OntologyCategorySchema>;
export type OntologyVersion = z.infer<typeof OntologyVersionSchema>;
