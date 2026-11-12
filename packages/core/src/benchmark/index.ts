/**
 * The public benchmark surface of `@vision-lens/core`.
 *
 * Everything a caller needs to score a run, gate it and read its artifact.
 * Specs 006 (arena) and 007 (training) consume THIS module — there is no
 * second metric code path anywhere in the platform (plan.md → "Runner purity").
 */

export * from './metrics.js';
export * from './calibration.js';
export * from './splits.js';
// The taxonomy is exported member by member: its label-key constants are
// owned by the normaliser, and a blanket re-export would collide with them.
export {
  buildTaxonomy,
  labelKeyOf,
  taxonomyNameOf,
  TAXONOMY_DESCRIPTION,
  type Taxonomy,
  type TaxonomyCategory,
  type TaxonomyDocument,
} from './taxonomy.js';
export * from './config-fingerprint.js';
export * from './runner.js';
export * from './gate.js';
// The scorecard (spec 022) owns the regime vocabulary the gate's comparison
// path consumes through `checkScorecardBaseline`; none of its export names
// collides with the modules above.
export * from './scorecard.js';
export * from './registry.js';
export * from './normalize.js';
export * from './dataset-availability.js';
