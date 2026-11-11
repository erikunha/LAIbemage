/**
 * The public benchmark surface of `@master-vision/core`.
 *
 * Everything a caller needs to score a run, gate it and read its artifact.
 * Specs 006 (arena) and 007 (training) consume THIS module — there is no
 * second metric code path anywhere in the platform (plan.md → "Runner purity").
 */

export * from './metrics.js';
export * from './calibration.js';
export * from './splits.js';
export * from './runner.js';
export * from './gate.js';
export * from './registry.js';
export * from './normalize.js';
export * from './dataset-availability.js';
