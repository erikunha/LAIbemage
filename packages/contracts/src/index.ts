import { z } from 'zod';

/**
 * Version of the contracts package. Bump on any breaking schema change so
 * consumers can gate on it (spec 002: domain model and contracts).
 */
export const CONTRACTS_VERSION = '0.1.0';

/**
 * Seed schema for a labeling unit that has been accepted into the system.
 * Grows into the full domain model across specs 002-004.
 */
export const UnitSeededSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export type UnitSeeded = z.infer<typeof UnitSeededSchema>;
