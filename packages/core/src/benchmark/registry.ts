/**
 * The dataset registry (spec 003, US1 / task 1.1).
 *
 * ## What this module is
 *
 * A typed reader/writer for `datasets/registry.json`: the tracked record of
 * **every dataset the platform is allowed to use** — where it came from, under
 * which license, at which version, and with which checksums.
 *
 * The registry exists because the constitution requires it:
 *
 * > Every dataset and model records license and terms before use (registry in
 * > `datasets/registry.json`).
 *
 * So the registry is not a convenience index — it is a **gate**. A dataset
 * entry without a license is not "incomplete metadata"; it is a dataset the
 * platform is not allowed to touch. {@link assertDatasetLicensed} therefore
 * refuses a missing or empty license outright, and the fetch/normalise paths
 * call it before they write a single byte.
 *
 * ## The checksum rule (the one that is easy to get wrong)
 *
 * The VisA archive is a **multipart** S3 upload, so its ETag is
 * `05c830591a1172938cb714895c9e0cfb-113` — the trailing `-113` is the part
 * count. A multipart ETag is **not** the content MD5 and **not** a checksum of
 * any kind; it cannot be compared against a locally computed digest.
 *
 * The only trustworthy digest is one computed from the bytes themselves. So:
 *
 *  - `sha256` is `null` in the tracked registry until a real fetch computed
 *    it (`--record-checksums` writes it);
 *  - `etag` is recorded as **provenance** (which object revision was fetched),
 *    never as a checksum;
 *  - an unpinned entry is reported as unpinned — never as "verified".
 *
 * ## The shape
 *
 * ```text
 * datasets/registry.json
 * ├── schemaVersion: 1
 * └── datasets[]
 *     ├── id, title, usage ("benchmark" | "research-only")
 *     ├── license, licenseUrl, commercialUse
 *     ├── source (the registry landing page), resource (the exact object URL)
 *     ├── version, archiveBytes, etag
 *     ├── parts { selected[], rationale }
 *     ├── sha256 (null until pinned), sha256PinnedAt (null until pinned)
 *     ├── attribution (the citation the license requires)
 *     └── fetchedAt (null until fetched), notes
 * ```
 */

import { z } from 'zod';

/** How a dataset may be used by the platform. */
export const DATASET_USAGES = ['benchmark', 'research-only'] as const;

/** One usage of the {@link DATASET_USAGES} enum. */
export type DatasetUsage = (typeof DATASET_USAGES)[number];

/** The registry file format version this module reads and writes. */
export const DATASET_REGISTRY_SCHEMA_VERSION = 1;

/**
 * A failure of the registry itself: a malformed file, an unknown dataset id,
 * or — most importantly — a dataset whose license is missing or empty.
 */
export class DatasetRegistryError extends Error {
  /** The Zod issues, flattened to `path: message` strings. */
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${message} — ${issues.join('; ')}` : message);
    this.name = 'DatasetRegistryError';
    this.issues = issues;
  }
}

/** The selected parts of a dataset plus the reason they were selected. */
export const DatasetPartsSchema = z.strictObject({
  /** The part (VisA object class) names this entry covers. */
  selected: z.array(z.string().min(1)),
  /** Why these parts and not others — recorded so the choice is auditable. */
  rationale: z.string().min(1),
});

/**
 * One dataset entry.
 *
 * The license fields are not optional metadata: {@link DatasetRegistryEntrySchema}
 * refuses an empty license string, and {@link assertDatasetLicensed} refuses a
 * missing one. `usage` distinguishes a dataset the platform may benchmark on
 * from one that is documented for research only.
 */
export const DatasetRegistryEntrySchema = z
  .strictObject({
    /** Stable identifier, e.g. `visa-subset`. */
    id: z.string().min(1),
    /** Human-readable title. */
    title: z.string().min(1),
    /** What the dataset may be used for. */
    usage: z.enum(DATASET_USAGES),
    /** SPDX-style license identifier or name, e.g. `CC BY 4.0`. Never empty. */
    license: z.string().min(1, 'a dataset must record its license before use'),
    /** Where the license text lives. */
    licenseUrl: z.url(),
    /** Whether the license permits commercial use. */
    commercialUse: z.boolean(),
    /** The registry landing page the dataset is published on. */
    source: z.url(),
    /** The exact object URL the bytes are fetched from. */
    resource: z.url(),
    /** The release version of the dataset. */
    version: z.string().min(1),
    /** Size of the archive in bytes, or `null` when it is not applicable. */
    archiveBytes: z.number().int().nonnegative().nullable(),
    /** The object ETag — provenance, never a checksum. */
    etag: z.string().min(1).nullable(),
    /** The parts covered by this entry and why. */
    parts: DatasetPartsSchema,
    /** sha256 of the fetched bytes — `null` until a real fetch pins it. */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'expected a 64-character lowercase sha256 digest')
      .nullable(),
    /** When the sha256 was pinned — `null` while the entry is unpinned. */
    sha256PinnedAt: z.iso.datetime({ offset: true }).nullable(),
    /** The citation the license requires when the dataset is used. */
    attribution: z.string().min(1),
    /** When the dataset was actually fetched — `null` until it was. */
    fetchedAt: z.iso.datetime({ offset: true }).nullable(),
    /** Free-form notes: caveats, deviations, provenance details. */
    notes: z.string(),
  })
  .superRefine((entry, ctx) => {
    if (entry.sha256 !== null && entry.sha256PinnedAt === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['sha256PinnedAt'],
        message: 'a pinned sha256 must carry the timestamp it was pinned at',
      });
    }
    if (entry.sha256PinnedAt !== null && entry.sha256 === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['sha256'],
        message: 'a pinned timestamp without a sha256 means the checksum was lost, not recorded',
      });
    }
  });

/** The whole registry file. */
export const DatasetRegistrySchema = z.strictObject({
  /** The format version of this file. */
  schemaVersion: z.literal(DATASET_REGISTRY_SCHEMA_VERSION),
  /** Every dataset the platform may use. */
  datasets: z.array(DatasetRegistryEntrySchema).min(1),
});

/** One dataset entry. */
export type DatasetRegistryEntry = z.infer<typeof DatasetRegistryEntrySchema>;

/** The whole registry file. */
export type DatasetRegistry = z.infer<typeof DatasetRegistrySchema>;

/**
 * Parses an unknown value into a registry.
 *
 * Throws {@link DatasetRegistryError} with every issue listed — the registry
 * is the gate, so a broken registry must never be half-understood.
 */
export function parseDatasetRegistry(raw: unknown): DatasetRegistry {
  const result = DatasetRegistrySchema.safeParse(raw);
  if (!result.success) {
    throw new DatasetRegistryError(
      'Invalid dataset registry',
      result.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

/**
 * Reads and parses a registry file.
 *
 * @param path - the path of `datasets/registry.json`.
 */
export async function loadDatasetRegistry(path: string): Promise<DatasetRegistry> {
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new DatasetRegistryError(`Cannot read the dataset registry at '${path}'`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DatasetRegistryError(`The dataset registry at '${path}' is not valid JSON`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  return parseDatasetRegistry(parsed);
}

/**
 * Writes a registry file atomically.
 *
 * The file is written to a sibling temp file and then renamed, so a crash
 * mid-write can never leave a half-written registry behind (the same rule the
 * rest of the repo follows for JSON artifacts).
 */
export async function saveDatasetRegistry(path: string, registry: DatasetRegistry): Promise<void> {
  const { rename, writeFile } = await import('node:fs/promises');
  const temp = `${path}.tmp`;
  const body = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(temp, body, 'utf8');
  await rename(temp, path);
}

/**
 * Finds one dataset entry by id.
 *
 * @throws {DatasetRegistryError} when no entry carries that id.
 */
export function findDataset(registry: DatasetRegistry, id: string): DatasetRegistryEntry {
  const entry = registry.datasets.find((candidate) => candidate.id === id);
  if (!entry) {
    const known = registry.datasets.map((candidate) => candidate.id).join(', ') || '(none)';
    throw new DatasetRegistryError(`No dataset '${id}' in the registry`, [`known ids: ${known}`]);
  }
  return entry;
}

/**
 * The constitutional gate: a dataset may only be used with a recorded,
 * non-empty license.
 *
 * @throws {DatasetRegistryError} when the license is missing or blank.
 */
export function assertDatasetLicensed(entry: DatasetRegistryEntry): void {
  const license = entry.license?.trim() ?? '';
  if (license.length === 0) {
    throw new DatasetRegistryError(
      `Dataset '${entry.id}' records no license and may not be used`,
      ['every dataset and model records license and terms before use'],
    );
  }
}

/**
 * Assert that a dataset may be USED as a benchmark source.
 *
 * {@link assertDatasetLicensed} only checks that a license exists. This adds
 * the second half of the gate: a dataset recorded as `research-only` — or one
 * whose license forbids commercial use — may be documented, but the platform
 * must not fetch it, normalize it or score against it.
 *
 * MVTec AD is the case in point: CC BY-NC-SA 4.0 forbids commercial use, so
 * it stays a research reference. Without this gate, a later edit that added
 * parts to its entry would quietly make a non-commercial dataset fetchable.
 */
export function assertDatasetUsable(entry: DatasetRegistryEntry): void {
  assertDatasetLicensed(entry);
  if (entry.usage !== 'benchmark') {
    throw new DatasetRegistryError(
      `Dataset '${entry.id}' is recorded as '${entry.usage}' and may not be fetched or scored against`,
      [
        "a dataset is only usable when its registry entry records usage 'benchmark'",
        'research-only datasets stay documented and are never downloaded',
      ],
    );
  }
  if (entry.commercialUse !== true) {
    throw new DatasetRegistryError(
      `Dataset '${entry.id}' records a license that forbids commercial use (${entry.license}) ` +
        'and may not be fetched or scored against',
      ['the platform is commercial; a non-commercial license disqualifies the dataset'],
    );
  }
}

/**
 * Records the checksums of a fetched dataset into the registry.
 *
 * This is the ONLY write path that may set `sha256`: it is called after a
 * fetch computed the digest from the bytes themselves. `sha256PinnedAt` and
 * `fetchedAt` are stamped with the same instant so the two never disagree.
 *
 * @param registryPath - the path of `datasets/registry.json`.
 * @param id - the dataset id to update.
 * @param sha256 - the digest computed from the fetched bytes.
 * @param now - the instant to stamp (injectable for deterministic tests).
 */
export async function recordChecksums(
  registryPath: string,
  id: string,
  sha256: string,
  now: Date = new Date(),
): Promise<DatasetRegistryEntry> {
  const registry = await loadDatasetRegistry(registryPath);
  const entry = findDataset(registry, id);
  const stamp = now.toISOString();
  const updated: DatasetRegistryEntry = {
    ...entry,
    sha256,
    sha256PinnedAt: stamp,
    fetchedAt: stamp,
  };
  const next: DatasetRegistry = {
    ...registry,
    datasets: registry.datasets.map((candidate) => (candidate.id === id ? updated : candidate)),
  };
  // The written registry must still satisfy the schema — a checksum is never
  // written into a file that cannot be read back.
  const validated = parseDatasetRegistry(next);
  await saveDatasetRegistry(registryPath, validated);
  return findDataset(validated, id);
}

/**
 * Whether an entry carries a pinned checksum.
 *
 * An unpinned entry has never been fetched (or has been fetched without
 * `--record-checksums`); it cannot be verified, only re-fetched.
 */
export function isPinned(entry: DatasetRegistryEntry): boolean {
  return entry.sha256 !== null;
}
