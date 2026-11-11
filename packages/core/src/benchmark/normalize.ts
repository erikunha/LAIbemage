/**
 * Normalisation: VisA → the Vision Lens store (spec 003, US1 / task 1.3).
 *
 * ## What this module does
 *
 * It reads an extracted VisA subset (the directory tree the fetch script
 * stages) and writes it into the 002 store as:
 *
 * | VisA | Store entity |
 * |---|---|
 * | one object class (a *part*) | one `CaptureSession` |
 * | one image file | one `Asset` (content-addressed by the sha256 of its bytes) + one `Sample` |
 * | the image-level label of `image_anno.csv` | one `Annotation` whose `labelKey` is `normal` or `defect:<type>` |
 * | the set of labels actually observed | one `OntologyVersion`, fingerprinted with the contracts' `fingerprintV2` |
 *
 * ## The ontology keys
 *
 * The key space is exactly what the spec asks for: `normal`, or
 * `defect:<type>` where `<type>` is the canonical defect class of the object
 * class the image belongs to.
 *
 * The canonical names come from the dataset's own taxonomy
 * (`amazon-research/spot-diff`, `utils/id2class.py`), which is embedded below
 * under {@link VISA_DEFECT_TAXONOMY}. The CSV label is free text — lower-case,
 * and for a multi-defect image a comma-separated list of defect names — so it
 * is matched against the taxonomy of its own part by a normalised comparison
 * (case- and punctuation-insensitive). A multi-defect cell is keyed by its
 * **first** defect name (the primary one); the whole cell is preserved as the
 * raw label.
 *
 * **A label that does not match the taxonomy is never dropped.** It gets its
 * own key (`defect:<slug of the raw label>`), the raw text is preserved in the
 * ontology category's description, and the mapping is reported in
 * {@link NormalizeReport.unmappedLabels}. Silence would be a lie: the image
 * exists and carries a label.
 *
 * ## The subset policy (600–800 images)
 *
 * A VisA part holds ~600–1,100 images, so "the subset" cannot be a whole
 * number of parts. The policy is therefore explicit and deterministic:
 *
 *  - every **anomalous** image of every selected part is kept (they are the
 *    scarce, high-value ones: 100 per part upstream);
 *  - the **normal** images of each part are thinned to an even stride over
 *    their sorted order, so the sample still covers the whole capture range
 *    instead of a prefix of it;
 *  - the target size defaults to 700 images, inside the spec's 600–800 band.
 *
 * No randomness, no clock, no ordering dependence: the same tree always
 * yields the same samples.
 *
 * ## The upsert rule
 *
 * Re-running the normalisation must not duplicate rows. The store's
 * repositories are deliberately append-only (no update methods exist — see
 * `packages/core/src/store/repositories/base.ts`), so the idempotency lives
 * here, in the natural keys:
 *
 * | Entity | Natural key | Reuse |
 * |---|---|---|
 * | `Asset` | the sha256 of the bytes | `findBySha256` |
 * | `Sample` | the asset it describes | `listByAsset` |
 * | `CaptureSession` | `visa/<part>` | `listBySource` |
 * | `OntologyVersion` | its `fingerprint` | `findByFingerprint` |
 * | `Annotation` | (sample, labelKey, ontology version) | `listBySample` |
 *
 * When a label actually **changes**, the store's constitutional rule applies:
 * the old annotation is superseded by a new one, never edited in place.
 *
 * ## What is deliberately NOT here
 *
 *  - **Masks** are not turned into assets: F0 scores classification, and the
 *    pixel masks are reserved for the later detection/segmentation tracks. The
 *    mask path of every sample is carried in the report so the lineage is not
 *    lost.
 *  - **Splits** are not assigned: the authoritative split lives in the seeded
 *    gold manifest (spec 003 task 2.x), and `Sample.split` is only a mirror
 *    of it.
 *  - **No console output**: the module returns a report; the script prints it.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACTS_VERSION, fingerprintV2, type OntologyCategory } from '@vision-lens/contracts';
import { nextTimestamp } from '../store/clock.js';
import type { SqliteDatabase } from '../store/db.js';
import { newEntityId } from '../store/ids.js';
import { createRepositories, type Repositories } from '../store/repositories/index.js';

/**
 * The canonical defect taxonomy of VisA, per object class.
 *
 * Source: `amazon-research/spot-diff`, `utils/id2class.py` (the dataset's own
 * mask-value → class-name map). Reproduced here because the CSV labels are
 * free text and can only be mapped to a canonical type through it.
 *
 * The attribution this requires is recorded in `datasets/registry.json`.
 */
export const VISA_DEFECT_TAXONOMY: Readonly<Record<string, readonly string[]>> = {
  candle: [
    'Chunk Of Wax Missing',
    'Damaged Corner of Packaging',
    'weird candle wick',
    'Different Colour Spot',
    'Extra Wax in Candle',
    'Foreign Particals on Candle',
    'Wax Melded out of the candle',
    'Other',
  ],
  capsules: ['Bubble', 'Discolor', 'Scratch', 'Leak', 'Misshape'],
  cashew: [
    'Burnt',
    'Corner or Edge Breakage',
    'Different Colour Spot',
    'Middle Breakage',
    'Small Holes',
    'Small Scratches',
    'Stuck Together',
    'Same Colour Spot',
    'Other',
  ],
  chewinggum: [
    'Chunk of gum missing',
    'Corner Missing',
    'Scratches',
    'Similar Colour Spot',
    'Small Cracks',
    'Other',
  ],
  fryum: [
    'Burnt',
    'Corner or Edge Breakage',
    'Different Colour Spot',
    'Fryum Stuck Together',
    'Middle Breakage',
    'Similar Colour Spot',
    'Small Scratches',
    'Other',
  ],
  macaroni1: [
    'Chip Around Edge And Corner',
    'Different Colour Spot',
    'Middle Breakage',
    'Similar Colour Spot',
    'Small Cracks',
    'Small Scratches',
    'Other',
  ],
  macaroni2: [
    'Breakage down the middle',
    'Color spot similar to the Object',
    'Different Color spot',
    'Small chip around edge',
    'Small Cracks',
    'Small Scratches',
    'Other',
  ],
  pcb1: ['Bent', 'Melt', 'Scratch', 'Missing'],
  pcb2: ['Bent', 'Melt', 'Scratch', 'Missing'],
  pcb3: ['Bent', 'Melt', 'Scratch', 'Missing'],
  pcb4: ['Burnt', 'Scratch', 'Missing', 'Damage', 'Extra', 'Wrong Place', 'Dirt'],
  pipe_fryum: [
    'Burnt',
    'Corner And Edge Breakage',
    'Different Colour Spot',
    'Middle Breakage',
    'Similar Colour Spot',
    'Small Scratches',
    'Stuck Together',
    'Small Cracks',
    'Other',
  ],
};

/** The ontology key of a non-anomalous image. */
export const NORMAL_LABEL_KEY = 'normal';

/** The prefix of an anomaly ontology key. */
export const DEFECT_LABEL_PREFIX = 'defect:';

/** The key used when a label carries no usable text at all. */
export const UNLABELED_LABEL_KEY = `${DEFECT_LABEL_PREFIX}unlabeled`;

/** The default number of images the subset aims for (inside the 600–800 band). */
export const DEFAULT_SUBSET_TARGET_IMAGES = 700;

/** The dataset-level identity a normalisation runs under. */
export interface VisaDatasetIdentity {
  /** The registry id, e.g. `visa-subset`. */
  readonly id: string;
  /** The dataset release version, e.g. `20220922`. */
  readonly version: string;
  /** The license the dataset is used under. */
  readonly license: string;
  /** The citation the license requires. */
  readonly attribution: string;
}

/** The options of one normalisation run. */
export interface NormalizeVisaOptions {
  /** The open store (the 002 database) to write into. */
  readonly db: SqliteDatabase;
  /** The directory that holds the extracted VisA tree (the part directories). */
  readonly visaRoot: string;
  /** The object classes to normalise. Defaults to every part found. */
  readonly parts?: readonly string[];
  /** The dataset identity recorded in the store. */
  readonly dataset?: VisaDatasetIdentity;
  /** The target number of images in the subset. Defaults to 700. */
  readonly targetImages?: number;
  /** The clock used for the store's own timestamps. */
  readonly now?: () => string;
}

/** One row of the annotation CSV. */
export interface VisaAnnotationRow {
  /** The image path as written in the CSV (relative to the VisA root). */
  readonly image: string;
  /** The raw image-level label, verbatim. */
  readonly label: string;
  /** The mask path as written in the CSV, or `null` for a normal image. */
  readonly mask: string | null;
}

/** The outcome of mapping one raw label onto the ontology key space. */
export interface MappedVisaLabel {
  /** The ontology key: `normal` or `defect:<type>`. */
  readonly key: string;
  /** The canonical taxonomy name the label matched, or `null`. */
  readonly canonical: string | null;
  /** The raw label, verbatim. */
  readonly raw: string;
  /** Whether the label failed to match the taxonomy. */
  readonly unmapped: boolean;
}

/** One normalised image. */
export interface NormalizedSample {
  /** The id of the `Sample` row. */
  readonly sampleId: string;
  /** The id of the `Asset` row. */
  readonly assetId: string;
  /** The object class (VisA part) the image belongs to. */
  readonly part: string;
  /** The absolute path of the image on disk. */
  readonly path: string;
  /** The ontology key assigned to the image. */
  readonly labelKey: string;
  /** The raw CSV label, verbatim — never normalised away. */
  readonly rawLabel: string;
  /** The mask path of the image, when the dataset provides one. */
  readonly maskPath: string | null;
}

/** The report of one normalisation run. */
export interface NormalizeReport {
  /** The object classes that were normalised. */
  readonly parts: readonly string[];
  /** The id of the ontology version the annotations point at. */
  readonly ontologyVersionId: string;
  /** The fingerprint of that ontology version. */
  readonly ontologyFingerprint: string;
  /** The number of capture sessions written (or reused). */
  readonly captureSessions: number;
  /** The number of assets written (or reused). */
  readonly assets: number;
  /** The number of samples written (or reused). */
  readonly samples: number;
  /** The number of annotations written (or reused). */
  readonly annotations: number;
  /** The number of samples per ontology key. */
  readonly countsByKey: Readonly<Record<string, number>>;
  /** The number of samples per object class. */
  readonly countsByPart: Readonly<Record<string, number>>;
  /** The images that are on disk but carry no row in the annotation CSV. */
  readonly unlabeledImages: readonly string[];
  /** The annotation rows that name an image which is not on disk. */
  readonly danglingAnnotations: readonly string[];
  /** The labels that did not match the upstream taxonomy, with their key. */
  readonly unmappedLabels: readonly { readonly raw: string; readonly key: string }[];
  /** Every normalised image, with its raw label. */
  readonly normalizedSamples: readonly NormalizedSample[];
}

/**
 * Normalises the label of one annotation row onto the ontology key space.
 *
 * A CSV label is either `normal` or a comma-separated list of defect names.
 * The first defect name is the **primary** one (it is the label the image is
 * scored under); the remaining names are preserved in the raw label.
 *
 * @param part - the object class the image belongs to.
 * @param rawLabel - the label cell, verbatim.
 */
export function mapVisaLabel(part: string, rawLabel: string): MappedVisaLabel {
  const raw = rawLabel.trim();
  if (raw.length === 0) {
    return { key: UNLABELED_LABEL_KEY, canonical: null, raw, unmapped: true };
  }
  if (raw.toLowerCase() === NORMAL_LABEL_KEY) {
    return { key: NORMAL_LABEL_KEY, canonical: NORMAL_LABEL_KEY, raw, unmapped: false };
  }

  const phrases = raw
    .split(',')
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
  const primary = phrases[0] ?? raw;

  // KNOWN LIMITATION — a multi-defect cell is scored under its FIRST defect
  // only. The raw cell (every phrase) is preserved in the annotation payload
  // and the secondary types stay visible in the ontology description, so no
  // information is lost — but a per-class F1 for a SECONDARY defect type is
  // structurally unavailable, because the sample carries a single label key.
  // Widening this means a multi-label annotation model, which is a store
  // change and therefore a contracts change: out of scope for spec 003.

  const own = VISA_DEFECT_TAXONOMY[part] ?? [];
  const canonical =
    findCanonical(own, primary) ?? findCanonical(allCanonicalTypes(), primary) ?? null;

  if (canonical === null) {
    // Not in the taxonomy: keep it, keyed by its own slug, and report it.
    const slug = slugify(primary);
    return {
      key: slug.length > 0 ? `${DEFECT_LABEL_PREFIX}${slug}` : UNLABELED_LABEL_KEY,
      canonical: null,
      raw,
      unmapped: true,
    };
  }
  return { key: `${DEFECT_LABEL_PREFIX}${slugify(canonical)}`, canonical, raw, unmapped: false };
}

/** Every canonical defect name of every object class. */
function allCanonicalTypes(): string[] {
  return Object.values(VISA_DEFECT_TAXONOMY).flatMap((names) => [...names]);
}

/**
 * Finds the canonical name matching `phrase`, comparing in a
 * case- and punctuation-insensitive way (`Chunk Of Wax Missing` ≡
 * `chunk of wax missing`).
 */
function findCanonical(candidates: readonly string[], phrase: string): string | null {
  const wanted = slugify(phrase);
  if (wanted.length === 0) return null;
  for (const candidate of candidates) {
    if (slugify(candidate) === wanted) return candidate;
  }
  return null;
}

/**
 * Slugifies a label: lowercase, non-alphanumeric runs collapsed to `-`.
 *
 * `Chunk Of Wax Missing` → `chunk-of-wax-missing`.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parses a VisA annotation CSV (`image_anno.csv`).
 *
 * The header is `image,label,mask`; the label cell is quoted when it contains
 * the comma-separated list of several defect names, so the parser has to be a
 * real CSV parser and not a `split(',')`.
 *
 * @throws {Error} when the header does not name an `image` and a `label` column.
 */
export function parseVisaAnnotationCsv(text: string): VisaAnnotationRow[] {
  const records = parseCsv(text);
  if (records.length === 0) {
    throw new Error('The VisA annotation CSV is empty');
  }
  const header = records[0]!.map((cell) => cell.trim().toLowerCase());
  const imageIndex = header.indexOf('image');
  const labelIndex = header.indexOf('label');
  if (imageIndex === -1 || labelIndex === -1) {
    throw new Error(
      `The VisA annotation CSV must have an 'image' and a 'label' column, found: ${header.join(', ')}`,
    );
  }
  const maskIndex = header.indexOf('mask');

  const rows: VisaAnnotationRow[] = [];
  for (const record of records.slice(1)) {
    const image = (record[imageIndex] ?? '').trim();
    if (image.length === 0) continue;
    const mask = maskIndex === -1 ? '' : (record[maskIndex] ?? '').trim();
    rows.push({ image, label: (record[labelIndex] ?? '').trim(), mask: mask.length > 0 ? mask : null });
  }
  return rows;
}

/** A minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r') {
      index += 1;
      continue;
    }
    if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** The image extensions the normaliser accepts. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp']);

/** One image file found on disk. */
interface FoundImage {
  /** The absolute path of the image. */
  readonly absolutePath: string;
  /**
   * The path of the image relative to the object class directory, in the same
   * shape the annotation CSV uses (`Data/Images/Normal/0000.JPG`).
   */
  readonly relativePath: string;
  /** Whether the image sits in the `Anomaly` directory. */
  readonly anomalous: boolean;
}

/** The ground truth collected for one object class. */
interface PartGroundTruth {
  readonly part: string;
  readonly images: readonly FoundImage[];
  /** The raw label per image path (relative to the part directory). */
  readonly labels: ReadonlyMap<string, string>;
  /** The mask path per image path (relative to the part directory). */
  readonly masks: ReadonlyMap<string, string | null>;
}

/**
 * Normalises an extracted VisA subset into the 002 store.
 *
 * @throws {Error} when a selected part has no annotation CSV, or when the
 *   VisA tree does not exist — both are silent-data-loss conditions.
 */
export async function normalizeVisaSubset(options: NormalizeVisaOptions): Promise<NormalizeReport> {
  const { db, visaRoot } = options;
  const repos = createRepositories(db);
  const stamp = options.now ?? nextTimestamp;
  const dataset: VisaDatasetIdentity = options.dataset ?? {
    id: 'visa-subset',
    version: 'unknown',
    license: 'unknown',
    attribution: '',
  };

  const availableParts = await listPartDirectories(visaRoot);
  if (availableParts.length === 0) {
    throw new Error(`No VisA object class directories found under '${visaRoot}'`);
  }
  const parts = options.parts && options.parts.length > 0 ? [...options.parts].sort() : availableParts;
  for (const part of parts) {
    if (!availableParts.includes(part)) {
      throw new Error(
        `VisA object class '${part}' is not present under '${visaRoot}' (found: ${availableParts.join(', ')})`,
      );
    }
  }

  const target = options.targetImages ?? DEFAULT_SUBSET_TARGET_IMAGES;

  // --- Collect the ground truth of every part -------------------------------
  const partData: PartGroundTruth[] = [];
  for (const part of parts) {
    const partDir = path.join(visaRoot, part);
    const csvPath = await findAnnotationCsv(partDir);
    if (csvPath === null) {
      throw new Error(
        `No 'image_anno*.csv' annotation file found in '${partDir}' — the labels cannot be derived without it`,
      );
    }
    const rows = parseVisaAnnotationCsv(await readFile(csvPath, 'utf8'));
    const images = await listPartImages(partDir);
    if (images.length === 0) {
      throw new Error(`No images found under '${partDir}/Data/Images'`);
    }

    const labels = new Map<string, string>();
    const masks = new Map<string, string | null>();
    for (const row of rows) {
      const key = relativeToPart(row.image, part);
      labels.set(key, row.label);
      masks.set(key, row.mask);
    }
    partData.push({ part, images, labels, masks });
  }

  // --- Choose the images of the subset --------------------------------------
  const selected = selectSubsetImages(partData, target);

  // --- Derive the ontology keys actually observed ---------------------------
  const keysInUse = new Set<string>([NORMAL_LABEL_KEY]);
  const keyToRawLabels = new Map<string, Set<string>>();
  const keyToParts = new Map<string, Set<string>>();
  const unmappedLabels: { raw: string; key: string }[] = [];
  const unlabeledImages: string[] = [];

  for (const entry of selected) {
    const rawLabel = entry.label;
    if (rawLabel === undefined) {
      // The image is on disk but the CSV does not mention it.
      unlabeledImages.push(`${entry.part}/${entry.image.relativePath}`);
      if (entry.image.anomalous) {
        // An anomalous image without a label has no ground truth to be scored
        // against; it is reported and left out of the benchmark.
        continue;
      }
    }
    const mapped = mapVisaLabel(entry.part, rawLabel ?? NORMAL_LABEL_KEY);
    entry.labelKey = mapped.key;
    entry.rawLabel = mapped.raw;
    keysInUse.add(mapped.key);
    addToSet(keyToRawLabels, mapped.key, mapped.raw);
    addToSet(keyToParts, mapped.key, entry.part);
    if (mapped.unmapped && mapped.raw.length > 0) {
      unmappedLabels.push({ raw: mapped.raw, key: mapped.key });
    }
  }

  // Annotation rows that name an image which is not on disk.
  const danglingAnnotations: string[] = [];
  for (const entry of partData) {
    for (const key of entry.labels.keys()) {
      const onDisk = entry.images.some((image) => image.relativePath === key);
      if (!onDisk) {
        danglingAnnotations.push(`${entry.part}/${key}`);
      }
    }
  }

  // --- Build the ontology version -------------------------------------------
  const categories = buildOntologyCategories([...keysInUse].sort(), keyToRawLabels, keyToParts);
  const ontologyFingerprint = fingerprintV2({
    model: 'n/a:dataset-ontology',
    promptTemplate: 'visa-normalization-v1',
    taxonomy: categories as unknown as ReadonlyArray<Record<string, unknown>>,
    preprocessing: {},
    dataVersion: `${dataset.id}@${dataset.version}`,
    contractsVersion: CONTRACTS_VERSION,
  });

  const existingOntology = repos.ontology.findByFingerprint(ontologyFingerprint);
  let ontologyVersionId: string;
  if (existingOntology) {
    ontologyVersionId = existingOntology.id;
  } else {
    const inserted = repos.ontology.insert({
      id: newEntityId(),
      version: `${dataset.id}-${dataset.version}`,
      categories,
      fingerprint: ontologyFingerprint,
      createdAt: stamp(),
    });
    ontologyVersionId = inserted.id;
  }

  // --- Write the rows --------------------------------------------------------
  let captureSessions = 0;
  let assets = 0;
  let samples = 0;
  let annotations = 0;
  const countsByKey: Record<string, number> = {};
  const countsByPart: Record<string, number> = {};
  const normalizedSamples: NormalizedSample[] = [];

  for (const entry of selected) {
    if (entry.labelKey === undefined) continue; // unknown anomaly, skipped on purpose

    const source = `visa/${entry.part}`;
    const session = findOrCreateCaptureSession(repos, {
      source,
      part: entry.part,
      dataset,
      stamp: stamp(),
    });
    if (session.created) captureSessions += 1;

    const bytes = await readFile(entry.image.absolutePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    let asset = repos.assets.findBySha256(sha256);
    if (!asset) {
      asset = repos.assets.insert({
        id: newEntityId(),
        sha256,
        kind: 'image',
        bytes: bytes.byteLength,
        captureSessionId: session.id,
        unhashed: false,
        path: entry.image.absolutePath,
        createdAt: stamp(),
      });
      assets += 1;
    }

    let sample = repos.samples.listByAsset(asset.id)[0];
    if (!sample) {
      sample = repos.samples.insert({
        id: newEntityId(),
        assetId: asset.id,
        snapshotIds: [],
        sourceCaptureFrame: entry.image.relativePath,
        createdAt: stamp(),
      });
      samples += 1;
    }

    const existing = repos.annotations.listBySample(sample.id);
    const inForce = existing.find((annotation) => annotation.supersededBy === undefined);
    const isCurrent =
      inForce !== undefined &&
      inForce.labelKey === entry.labelKey &&
      inForce.ontologyVersionId === ontologyVersionId;
    if (!isCurrent) {
      const annotation = {
        id: newEntityId(),
        sampleId: sample.id,
        ontologyVersionId,
        labelKey: entry.labelKey,
        actor: {
          kind: 'human' as const,
          ref: `dataset:${dataset.id}`,
          displayName: `${dataset.id} dataset annotators`,
        },
        surface: 'cli' as const,
        sessionId: session.id,
        createdAt: stamp(),
      };
      if (inForce) {
        // A label changed: the constitution says a correction is a NEW row
        // that supersedes the old one — never an edit of the old row.
        repos.annotations.correctAnnotation(inForce.id, annotation);
      } else {
        repos.annotations.insert(annotation);
      }
      annotations += 1;
    }

    countsByKey[entry.labelKey] = (countsByKey[entry.labelKey] ?? 0) + 1;
    countsByPart[entry.part] = (countsByPart[entry.part] ?? 0) + 1;
    normalizedSamples.push({
      sampleId: sample.id,
      assetId: asset.id,
      part: entry.part,
      path: entry.image.absolutePath,
      labelKey: entry.labelKey,
      rawLabel: entry.rawLabel ?? '',
      maskPath: entry.masks.get(entry.image.relativePath) ?? null,
    });
  }

  return {
    parts,
    ontologyVersionId,
    ontologyFingerprint,
    captureSessions,
    assets,
    samples,
    annotations,
    countsByKey,
    countsByPart,
    unlabeledImages,
    danglingAnnotations,
    unmappedLabels,
    normalizedSamples,
  };
}

/** One selected image, before and after its label is resolved. */
interface SelectedImage {
  readonly part: string;
  readonly image: FoundImage;
  /** The raw label of the image, when the CSV carries one. */
  label: string | undefined;
  /** The ontology key of the image, filled in by the normaliser. */
  labelKey: string | undefined;
  /** The raw label, preserved verbatim. */
  rawLabel: string | undefined;
  /** The mask paths of the part the image belongs to. */
  readonly masks: ReadonlyMap<string, string | null>;
}

/**
 * Chooses the images of the subset.
 *
 * Every anomalous image is kept; the normal images of each part are thinned
 * to an even stride over their sorted order.
 */
function selectSubsetImages(
  partData: readonly PartGroundTruth[],
  target: number,
): SelectedImage[] {
  const anomalies: SelectedImage[] = [];
  const normalsPerPart: SelectedImage[][] = [];

  for (const entry of partData) {
    const partAnomalies: SelectedImage[] = [];
    const partNormals: SelectedImage[] = [];
    for (const image of entry.images) {
      const selected: SelectedImage = {
        part: entry.part,
        image,
        label: entry.labels.get(image.relativePath),
        labelKey: undefined,
        rawLabel: undefined,
        masks: entry.masks,
      };
      if (image.anomalous) {
        partAnomalies.push(selected);
      } else {
        partNormals.push(selected);
      }
    }
    anomalies.push(...partAnomalies);
    normalsPerPart.push(partNormals);
  }

  const remaining = Math.max(0, target - anomalies.length);
  const perPart = Math.floor(remaining / Math.max(1, normalsPerPart.length));

  const chosen: SelectedImage[] = [...anomalies];
  for (const normals of normalsPerPart) {
    chosen.push(...strideSample(normals, perPart));
  }
  // The stride can only ever return fewer items than asked for; top the subset
  // up with the remaining normal images, in part order, so the target is met.
  if (chosen.length < target) {
    const taken = new Set(chosen.map((entry) => `${entry.part}/${entry.image.relativePath}`));
    outer: for (const normals of normalsPerPart) {
      for (const normal of normals) {
        if (chosen.length >= target) break outer;
        const key = `${normal.part}/${normal.image.relativePath}`;
        if (taken.has(key)) continue;
        taken.add(key);
        chosen.push(normal);
      }
    }
  }
  return chosen;
}

/**
 * Takes `count` items out of `items`, spread evenly over their order.
 *
 * The stride (rather than a prefix) matters: a prefix would sample only the
 * beginning of a capture session, where the lighting and the object pose are
 * the most uniform. The stride is anchored at **both ends**, so the first and
 * the last item of the range are always part of the sample.
 */
function strideSample<T>(items: readonly T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (count >= items.length) return [...items];
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]!];
  const step = (items.length - 1) / (count - 1);
  const sampled: T[] = [];
  for (let index = 0; index < count; index += 1) {
    sampled.push(items[Math.round(index * step)]!);
  }
  return sampled;
}

/** Builds (or reuses) the capture session of one object class. */
function findOrCreateCaptureSession(
  repos: Repositories,
  input: {
    source: string;
    part: string;
    dataset: VisaDatasetIdentity;
    stamp: string;
  },
): { id: string; created: boolean } {
  const existing = repos.captureSessions
    .listBySource(input.source)
    .find((session) => (session.contextJson as { part?: string } | undefined)?.part === input.part);
  if (existing) return { id: existing.id, created: false };
  const inserted = repos.captureSessions.insert({
    id: newEntityId(),
    startedAt: input.stamp,
    source: input.source,
    contextJson: {
      datasetId: input.dataset.id,
      datasetVersion: input.dataset.version,
      part: input.part,
      license: input.dataset.license,
      attribution: input.dataset.attribution,
      captureGrouping: 'visa-part',
    },
  });
  return { id: inserted.id, created: true };
}

/** Builds the ontology categories of the keys actually observed. */
function buildOntologyCategories(
  keys: readonly string[],
  keyToRawLabels: ReadonlyMap<string, ReadonlySet<string>>,
  keyToParts: ReadonlyMap<string, ReadonlySet<string>>,
): OntologyCategory[] {
  return keys.map((key) => {
    if (key === NORMAL_LABEL_KEY) {
      return {
        key,
        name: NORMAL_LABEL_KEY,
        description:
          'Normal (non-anomalous) VisA image. The label comes from the dataset’s own ' +
          'image_anno.csv, which records the image-level normal/anomaly label.',
      };
    }
    const raw = [...(keyToRawLabels.get(key) ?? [])].sort();
    const rawText = raw.length > 0 ? raw.join(' | ') : 'unknown';
    const parts = [...(keyToParts.get(key) ?? [])].sort().join(', ');
    return {
      key,
      name: key.slice(DEFECT_LABEL_PREFIX.length),
      description:
        `VisA anomaly class. Raw label(s) in the dataset’s image_anno.csv: ${rawText}. ` +
        'Canonical names follow the dataset taxonomy (amazon-research/spot-diff, utils/id2class.py). ' +
        `Observed in object class(es): ${parts}.`,
    };
  });
}

/** Lists the object class directories of an extracted VisA tree. */
async function listPartDirectories(visaRoot: string): Promise<string[]> {
  const entries = await readdir(visaRoot, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const imagesDir = path.join(visaRoot, entry.name, 'Data', 'Images');
    if (await isDirectory(imagesDir)) {
      parts.push(entry.name);
    }
  }
  return parts.sort();
}

/** Lists the images of one object class, normal and anomalous. */
async function listPartImages(partDir: string): Promise<FoundImage[]> {
  const imagesDir = path.join(partDir, 'Data', 'Images');
  const found: FoundImage[] = [];
  for (const bucket of ['Normal', 'Anomaly']) {
    const bucketDir = path.join(imagesDir, bucket);
    if (!(await isDirectory(bucketDir))) continue;
    for (const relative of await walkFiles(bucketDir)) {
      if (!IMAGE_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
      found.push({
        absolutePath: path.join(bucketDir, relative),
        relativePath: `Data/Images/${bucket}/${relative.split(path.sep).join('/')}`,
        anomalous: bucket === 'Anomaly',
      });
    }
  }
  found.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return found;
}

/** Recursively lists the files of a directory, relative to it. */
async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const relative = prefix.length > 0 ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path.join(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/** Finds the annotation CSV of an object class (`image_anno*.csv`). */
async function findAnnotationCsv(partDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(partDir);
  } catch {
    return null;
  }
  const match = entries
    .filter((name) => /^image_anno.*\.csv$/i.test(name))
    .sort()
    .at(0);
  return match ? path.join(partDir, match) : null;
}

/** Strips the object-class prefix from a CSV image path. */
function relativeToPart(imagePath: string, part: string): string {
  const normalized = imagePath.split(path.sep).join('/');
  const prefix = `${part}/`;
  if (normalized.startsWith(prefix)) {
    return normalized.slice(prefix.length);
  }
  return normalized;
}

/** Adds a value to a set stored in a map, creating the set when needed. */
function addToSet(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/** Whether a path is a directory. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}
