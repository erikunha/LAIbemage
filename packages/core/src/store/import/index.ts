/**
 * The legacy-run importer (spec 002, US2 / task 4).
 *
 * Two modules:
 *
 *  - {@link ./legacy-shape.js} — shape detection, normalization and the
 *    content-addressed manifest id (pure logic, no I/O).
 *  - {@link ./legacy-run.js} — the plan (what would be written) and the
 *    transactional write.
 */

export {
  LEGACY_RUN_SHAPES,
  LegacyImportError,
  asNumber,
  asString,
  asStringArray,
  basename,
  detectLegacyRunShape,
  isPlainObject,
  legacyRunManifestId,
  parseLegacyRun,
} from './legacy-shape.js';
export type {
  LegacyImageRecord,
  LegacyOverrideRecord,
  LegacyRun,
  LegacyRunShape,
  LegacySessionRecord,
} from './legacy-shape.js';

export {
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_REVIEWER_NAME,
  LEGACY_REVIEWER_REF,
  LEGACY_UNKNOWN_MODEL_NAME,
  LEGACY_UNKNOWN_MODEL_VERSION,
  defaultLegacyRoots,
  importLegacyRun,
  legacyLabelKey,
  planLegacyRunImport,
} from './legacy-run.js';
export type {
  ImportLegacyRunOptions,
  LegacyImportCounts,
  LegacyImportPlan,
  LegacyImportResult,
  LegacyRoots,
  PlannedAsset,
} from './legacy-run.js';
