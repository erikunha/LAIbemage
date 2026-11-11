/**
 * `laib import-run <path>` — import a legacy analysis run into the store
 * (spec 002, US2 / task 4.3).
 *
 * ## What the command does
 *
 * Reads a legacy run file (`analysis_results.json` and its historical
 * variants), maps it onto the domain model and writes it into the Master
 * Vision store. The originals are never touched: the run file and the image
 * bytes are read-only, and the only thing written is the target database.
 *
 * ## The flags
 *
 *  - `--dry-run` — print the mapping counts and write NOTHING. A dry run is a
 *    PREVIEW, not an estimate: it prints the same counts the real import
 *    reports.
 *  - `--db <path>` — the target store. Defaults to the store's
 *    `defaultStorePath()`.
 *
 * ## Why the store is imported DYNAMICALLY
 *
 * `better-sqlite3` is an OPTIONAL dependency of `@master-vision/core`: it is
 * a native module and it must not be loaded by commands that do not need it.
 * The dynamic import also keeps `laib --help` and the other subcommands free
 * of the native driver.
 */
import type { LegacyImportCounts, LegacyImportResult } from '@master-vision/core/store';

/** Options of the `import-run` command. */
export interface ImportRunCommandOptions {
  /** Path of the legacy run file. */
  readonly runPath: string;
  /** Path of the target store database. Defaults to the store's default. */
  readonly dbPath?: string;
  /** Print the mapping counts without writing anything. */
  readonly dryRun?: boolean;
}

/**
 * The lines the command prints.
 *
 * Pure: no I/O, no store. The CLI test asserts on these lines, and the dry
 * run and the real run print THE SAME lines — only the status line differs.
 */
export function formatImportRunSummary(
  result: LegacyImportResult,
  options: { readonly dbPath: string; readonly dryRun: boolean },
): string[] {
  const counts: LegacyImportCounts = result.counts;
  const status = options.dryRun
    ? 'dry run — nothing was written'
    : result.alreadyImported
      ? 'already imported — nothing was written'
      : 'imported';

  return [
    `legacy run:      ${result.runPath}`,
    `store:           ${options.dbPath}`,
    `manifest id:     ${result.manifestId}`,
    `shape:           ${result.shape}`,
    `status:          ${status}`,
    `assets:          ${counts.assets} (hashed ${counts.assetsHashed}, unhashed ${counts.assetsUnhashed})`,
    `samples:         ${counts.samples}`,
    `predictions:     ${counts.predictions}`,
    `annotations:     ${counts.annotations}`,
    `capture sessions:${counts.captureSessions}`,
    `ontology versions:${counts.ontologyVersions}`,
    `model versions:  ${counts.modelVersions}`,
    `experiment runs: ${counts.experimentRuns}`,
    `legacy carry-overs: ${counts.legacyCarryOvers}`,
    `legacy conditions:${counts.legacyConditions}`,
    ...(counts.skippedRecords > 0 ? [`skipped records:  ${counts.skippedRecords}`] : []),
    ...(counts.unmatchedOverrides > 0
      ? [`unmatched overrides: ${counts.unmatchedOverrides}`]
      : []),
  ];
}

/**
 * Runs the `import-run` command.
 *
 * Throws on every failure (missing file, unreadable file, invalid JSON,
 * unknown shape, store failure): the caller turns that into a clear message
 * and a non-zero exit code.
 */
export async function runImportRun(options: ImportRunCommandOptions): Promise<LegacyImportResult> {
  // The store is loaded lazily: better-sqlite3 is an optional native
  // dependency and must not be loaded by the other commands.
  const store = await import('@master-vision/core/store');
  const dbPath = options.dbPath ?? store.defaultStorePath();

  if (options.dryRun) {
    const result = await store.importLegacyRun({
      runPath: options.runPath,
      dryRun: true,
    });
    await printSummary(result, { dbPath, dryRun: true });
    return result;
  }

  const handle = await store.openMigratedStore(dbPath);
  try {
    const result = await store.importLegacyRun({
      runPath: options.runPath,
      store: handle,
    });
    await printSummary(result, { dbPath, dryRun: false });
    return result;
  } finally {
    handle.close();
  }
}

/** Prints the mapping counts (one per line, no debug noise). */
async function printSummary(
  result: LegacyImportResult,
  options: { readonly dbPath: string; readonly dryRun: boolean },
): Promise<void> {
  // The logger is loaded lazily as well, so this module can be imported
  // (and its pure formatter tested) without a built core package.
  const { logger } = await import('@master-vision/core/utils/logger');
  for (const line of formatImportRunSummary(result, options)) {
    logger.raw(line);
  }
}
