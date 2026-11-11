import { z } from 'zod';

/**
 * Version of the contracts package. Bump on any breaking schema change so
 * consumers can gate on it (spec 002: domain model and contracts).
 */
export { CONTRACTS_VERSION } from './version.js';

/**
 * Seed schema for a labeling unit that has been accepted into the system.
 * Grows into the full domain model across specs 002-004.
 */
export const UnitSeededSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export type UnitSeeded = z.infer<typeof UnitSeededSchema>;

export { canonicalJson, fingerprintV2 } from './fingerprint.js';
export type { FingerprintInput } from './fingerprint.js';

/* Enumerations of the domain model (ActorKind, Surface, JobState, …). */
export * from './enums.js';

/* Shared primitives (identity, timestamp, hash, provenance, actor unions). */
export * from './base.js';

/* The 14 entities, the 4 reserved stubs and the entity registry. */
export * from './entities/index.js';

/* Contract manifest (derived from the live schemas). */
export * from './manifest.js';

/* Pure breaking-change guard for the contract surface. */
export * from './version-guard.js';
