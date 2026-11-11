/**
 * Version of the contracts package.
 *
 * Bump on any breaking schema change so consumers can gate on it (spec 002:
 * domain model and contracts). The MAJOR version is the breaking-change
 * signal: a breaking shape change REQUIRES a MAJOR bump, enforced by
 * `version-guard.test.ts` (spec 002 task 1.4, FR-001).
 */
export const CONTRACTS_VERSION = '1.0.0';
