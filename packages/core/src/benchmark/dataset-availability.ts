/**
 * Dataset availability (spec 003, US1 / task 1.4, FR-007).
 *
 * ## Why this module exists
 *
 * The benchmark tests must run on a machine that has the dataset **and** on a
 * machine that has not. The rule (FR-007) is:
 *
 * > CI MUST skip benchmark tests with an explicit marker when the dataset is
 * > absent; never auto-download.
 *
 * So the decision "is the dataset here?" has to live in ONE place, shared by
 * the tests, the CI job and the CLI — otherwise one of them will grow its own
 * (slightly different) check and the skip will silently stop happening.
 *
 * ## The marker
 *
 * The skip marker is the literal string **`dataset=absent`**. It is exported
 * as {@link DATASET_ABSENT_MARKER} so that every surface prints the same
 * token, and it is what a CI log shows next to a skipped test.
 *
 * ## Where the dataset is looked for
 *
 * The environment variable **`VISION_LENS_DATASETS_DIR`** names the directory that
 * holds the dataset. When it is not set, the default is `<repo>/datasets`.
 *
 * The dataset counts as **present** only when that directory exists *and*
 * contains the expected marker file:
 *
 * ```text
 * $VISION_LENS_DATASETS_DIR/
 * └── visa-subset/          ← the staged subset
 *     └── .dataset-ready    ← the marker the fetch script writes
 * ```
 *
 * The marker file exists because "the directory is there" is not the same
 * claim as "the dataset is complete and verified". A half-extracted subset
 * (an interrupted fetch, a disk-full run) would otherwise look present to a
 * test that then fails with a confusing missing-file error instead of skipping
 * cleanly.
 *
 * ## What this module never does
 *
 * It never downloads anything and it never writes anything. It is a pure
 * read of the filesystem, so it is safe to call from a test, from CI and from
 * the CLI alike.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** The environment variable that names the datasets directory. */
export const DATASETS_DIR_ENV = 'VISION_LENS_DATASETS_DIR';

/** The explicit marker CI prints when the benchmark tests are skipped. */
export const DATASET_ABSENT_MARKER = 'dataset=absent';

/** The id of the VisA subset in `datasets/registry.json`. */
export const VISA_SUBSET_ID = 'visa-subset';

/** The name of the marker file that proves a staged dataset is complete. */
export const DATASET_READY_MARKER = '.dataset-ready';

/** The result of an availability check. */
export interface DatasetAvailability {
  /** Whether the dataset is present and ready to be used. */
  readonly present: boolean;
  /** The directory that was inspected. */
  readonly datasetsDir: string;
  /** The marker file that was expected. */
  readonly markerPath: string;
  /** Why the dataset is considered absent. `null` when it is present. */
  readonly reason: string | null;
}

/**
 * Resolves the datasets directory.
 *
 * The environment variable wins; otherwise the default `<repo>/datasets` is
 * used, resolved from this module's own location so it does not depend on the
 * process working directory.
 */
export function resolveDatasetsDir(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = path.dirname(new URL(import.meta.url).pathname),
): string {
  const fromEnv = env[DATASETS_DIR_ENV];
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  // <repo>/packages/core/src/benchmark → <repo>
  return path.resolve(moduleDir, '..', '..', '..', '..', 'datasets');
}

/**
 * Decides whether a dataset is present.
 *
 * @param datasetId - the dataset directory under the datasets directory.
 * @param env - the environment to read {@link DATASETS_DIR_ENV} from.
 */
export function datasetAvailable(
  datasetId: string = VISA_SUBSET_ID,
  env: NodeJS.ProcessEnv = process.env,
): DatasetAvailability {
  const datasetsDir = resolveDatasetsDir(env);
  const markerPath = path.join(datasetsDir, datasetId, DATASET_READY_MARKER);

  if (!existsSync(datasetsDir)) {
    return {
      present: false,
      datasetsDir,
      markerPath,
      reason: `the datasets directory '${datasetsDir}' does not exist`,
    };
  }
  if (!existsSync(markerPath)) {
    return {
      present: false,
      datasetsDir,
      markerPath,
      reason: `the dataset marker '${markerPath}' is missing — the subset is absent or was not completed`,
    };
  }
  if (!statSync(markerPath).isFile()) {
    return {
      present: false,
      datasetsDir,
      markerPath,
      reason: `the dataset marker '${markerPath}' is not a regular file`,
    };
  }
  return { present: true, datasetsDir, markerPath, reason: null };
}

/**
 * The message a surface prints when it skips because the dataset is absent.
 *
 * It always carries {@link DATASET_ABSENT_MARKER} so the skip is explicit in
 * a CI log rather than silent.
 */
export function datasetAbsentMessage(availability: DatasetAvailability): string {
  return `${DATASET_ABSENT_MARKER}: ${availability.reason ?? 'the dataset is not available'}`;
}
