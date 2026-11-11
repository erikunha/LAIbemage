/**
 * Shape detection and normalization for legacy analysis runs (spec 002, task 4.1).
 *
 * ## Why this module exists
 *
 * The legacy cache file has had **several shapes** over the life of the
 * pipeline, and the SAME FILENAME carries more than one of them. The importer
 * therefore never looks at the file name: it looks at the STRUCTURE of the
 * parsed JSON.
 *
 * | Shape | How it is recognised | Where it comes from |
 * |---|---|---|
 * | `flat-cache` | `images[]` whose records carry the analysis inline | `analysis_results.json` (final cache) |
 * | `partial-cache` | `images[]` whose records nest the analysis under `analysis` | `.analysis_cache_partial.json` (checkpoint) |
 * | `docs-results` | `results[]` | the shape the old docs described — never produced by the code, tolerated anyway |
 * | `docs-processed-files` | `processedFiles[]` | ditto |
 *
 * Anything else is an **error with an actionable message**, not a stack trace:
 * a file that is not a legacy run must not be silently imported as an empty
 * run.
 *
 * ## The manifest id (the idempotency key)
 *
 * The identity of a run is `sha256(canonicalJson(parsedContent))`.
 * `canonicalJson` (from `@master-vision/contracts`) sorts object keys, so a
 * file that was re-serialized with a different key order yields the SAME id.
 *
 * `processedDate` is deliberately NOT used: two different runs can share it,
 * and the same run imported twice must map to one id (SC-002).
 *
 * ## Everything here is defensive
 *
 * The legacy file is untrusted input: it may be truncated, hand-edited or
 * produced by an older build of the pipeline. Every field is read through a
 * tolerant accessor, and a value that cannot be read is treated as absent —
 * except where a wrong value would be a lie (a `confidence` outside 0..1 is
 * rejected, see {@link LegacyImportError}).
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '@master-vision/contracts';

/** A legacy run the importer could not read, or could not make sense of. */
export class LegacyImportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LegacyImportError';
  }
}

/** Every run shape the importer understands. */
export const LEGACY_RUN_SHAPES = [
  'flat-cache',
  'partial-cache',
  'docs-results',
  'docs-processed-files',
] as const;

/** The shape of a legacy run. */
export type LegacyRunShape = (typeof LEGACY_RUN_SHAPES)[number];

/** True for a non-null, non-array object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a string field, or `undefined` when it is absent or not a string. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads a finite number field, or `undefined`. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads an array of strings, dropping non-string members. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Detects the shape of a parsed legacy run by its structure.
 *
 * Throws {@link LegacyImportError} when the content is not a legacy run.
 */
export function detectLegacyRunShape(parsed: unknown): LegacyRunShape {
  if (!isPlainObject(parsed)) {
    throw new LegacyImportError(
      'Unrecognised legacy run: the file must contain a JSON object with an ' +
        '"images", "results" or "processedFiles" array.',
    );
  }

  const images = parsed['images'];
  if (Array.isArray(images)) {
    const nested = images.some(
      (entry) => isPlainObject(entry) && isPlainObject(entry['analysis']),
    );
    return nested ? 'partial-cache' : 'flat-cache';
  }
  if (Array.isArray(parsed['results'])) return 'docs-results';
  if (Array.isArray(parsed['processedFiles'])) return 'docs-processed-files';

  throw new LegacyImportError(
    'Unrecognised legacy run shape: expected an object with an "images", "results" or ' +
      '"processedFiles" array. Found keys: ' +
      (Object.keys(parsed).length > 0 ? Object.keys(parsed).join(', ') : '(none)') +
      '.',
  );
}

/**
 * The content-addressed identity of a parsed legacy run.
 *
 * `sha256(canonicalJson(parsed))` — key order does not matter, content does.
 */
export function legacyRunManifestId(parsed: unknown): string {
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}

/** One image record, normalized across every legacy shape. */
export interface LegacyImageRecord {
  /** Bare file name of the ORIGINAL image (never a path). */
  readonly fileName?: string;
  /** Bare file name of the EXPORTED image (never a path). */
  readonly outputFileName?: string;
  /** The label the model produced. */
  readonly category?: string;
  /** The sequence number of the record in the run. */
  readonly number?: number;
  /** One-line description. */
  readonly shortDescription?: string;
  /** Long description (absent in older runs). */
  readonly fullDescription?: string;
  /** Key visual elements. */
  readonly elements: readonly string[];
  /** LEGACY-ONLY free-text condition. It has no domain target — see the importer. */
  readonly condition?: string;
  /** Self-reported model confidence (absent in older runs). */
  readonly confidence?: number;
  /** OCR text (`null` means "no text detected"; absent means "not recorded"). */
  readonly extractedText?: string | null;
  /** Milliseconds since the epoch. MAY be a float in the wild. */
  readonly timestampMs?: number;
  /** The legacy session cluster this image belongs to. */
  readonly sessionId?: number;
  /** True when two providers disagreed on this image. */
  readonly lowConsensus?: boolean;
  /** Cross-image links, kept verbatim in the legacy carry-over. */
  readonly relatedImages?: unknown;
}

/** One legacy capture session (the `sessions[]` array). */
export interface LegacySessionRecord {
  readonly sessionId: number;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly imageNumbers: readonly number[];
}

/** One legacy review override (the `overrides[]` array). */
export interface LegacyOverrideRecord {
  readonly file?: string;
  readonly originalCategory?: string;
  readonly overriddenCategory?: string;
}

/** A parsed, normalized legacy run. */
export interface LegacyRun {
  /** The detected shape. */
  readonly shape: LegacyRunShape;
  /** The content-addressed id of the run (the idempotency key). */
  readonly manifestId: string;
  /** The run's completion timestamp, when it recorded one. */
  readonly processedDate?: string;
  /** The category NAMES the run used (never descriptions — the legacy file has none). */
  readonly categoryNames: readonly string[];
  /** The per-image records, normalized. */
  readonly images: readonly LegacyImageRecord[];
  /** The legacy capture sessions. */
  readonly sessions: readonly LegacySessionRecord[];
  /** The legacy review overrides (human labels). */
  readonly overrides: readonly LegacyOverrideRecord[];
  /** The model id the run recorded, when it recorded one. */
  readonly model?: string;
  /** The provider the run recorded, when it recorded one. */
  readonly provider?: string;
  /** The raw parsed content (kept for the verbatim legacy carry-over). */
  readonly raw: unknown;
}

/**
 * Parses and normalizes a legacy run.
 *
 * @param parsed - the already-parsed JSON content.
 * @throws {LegacyImportError} when the shape is unknown or a value is invalid.
 */
export function parseLegacyRun(parsed: unknown): LegacyRun {
  const shape = detectLegacyRunShape(parsed);
  const object = parsed as Record<string, unknown>;

  const rawImages = readImageArray(object, shape);
  const images = rawImages.map((entry, index) => normalizeImage(entry, shape, index));

  const categoryNames = collectCategoryNames(object, images);
  const sessions = normalizeSessions(object['sessions']);
  const overrides = normalizeOverrides(object['overrides']);

  const processedDate = asString(object['processedDate']);
  const model = asString(object['model']);
  const provider = asString(object['provider']);

  return {
    shape,
    manifestId: legacyRunManifestId(parsed),
    processedDate,
    categoryNames,
    images,
    sessions,
    overrides,
    model,
    provider,
    raw: parsed,
  };
}

/** Reads the array that holds the image records of the detected shape. */
function readImageArray(object: Record<string, unknown>, shape: LegacyRunShape): unknown[] {
  if (shape === 'docs-results') return object['results'] as unknown[];
  if (shape === 'docs-processed-files') return object['processedFiles'] as unknown[];
  return object['images'] as unknown[];
}

/**
 * Normalizes one image record.
 *
 * The `partial-cache` shape nests the analysis under `analysis`; the flat
 * shape carries it inline. Both are flattened into the same record so the
 * importer has ONE mapping to reason about.
 */
function normalizeImage(entry: unknown, shape: LegacyRunShape, index: number): LegacyImageRecord {
  // The docs-only `processedFiles` shape may be a plain list of file names.
  if (typeof entry === 'string') {
    return { fileName: basename(entry), elements: [] };
  }
  if (!isPlainObject(entry)) {
    throw new LegacyImportError(
      `Legacy run record #${index + 1} is not an object (found ${typeof entry}).`,
    );
  }

  const analysis = isPlainObject(entry['analysis']) ? entry['analysis'] : undefined;

  const fileName =
    asString(entry['originalFile']) ??
    asString(entry['file']) ??
    (asString(entry['fullPath']) ? basename(asString(entry['fullPath'])!) : undefined);

  const outputFileName = asString(entry['outputFile']);

  const category = asString(entry['category']) ?? asString(analysis?.['category']);

  const elements = asStringArray(entry['elements']);
  const nestedElements = analysis ? asStringArray(analysis['elements']) : [];

  const confidence = asNumber(entry['confidence']) ?? asNumber(analysis?.['confidence']);
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    throw new LegacyImportError(
      `Legacy run record #${index + 1} has a confidence of ${confidence}, which is outside 0..1. ` +
        'The value is not clamped: a fabricated probability would be worse than a failed import.',
    );
  }

  const extractedText = readExtractedText(entry, analysis);

  const timestampMs =
    asNumber(entry['timestamp']) ??
    asNumber(entry['createdAt']) ??
    (analysis ? asNumber(analysis['timestamp']) : undefined);

  return {
    fileName,
    outputFileName,
    category,
    number: asNumber(entry['number']),
    shortDescription: asString(entry['shortDescription']) ?? asString(analysis?.['shortDescription']),
    fullDescription: asString(entry['fullDescription']) ?? asString(analysis?.['fullDescription']),
    elements: elements.length > 0 ? elements : nestedElements,
    condition: asString(entry['condition']),
    confidence,
    extractedText,
    timestampMs,
    sessionId: asNumber(entry['sessionId']),
    lowConsensus:
      typeof entry['lowConsensus'] === 'boolean' ? (entry['lowConsensus'] as boolean) : undefined,
    relatedImages: entry['relatedImages'],
  };
}

/** Reads the OCR text, distinguishing "absent" from "explicitly null". */
function readExtractedText(
  entry: Record<string, unknown>,
  analysis: Record<string, unknown> | undefined,
): string | null | undefined {
  if ('extractedText' in entry) {
    const value = entry['extractedText'];
    return typeof value === 'string' ? value : null;
  }
  if (analysis && 'extractedText' in analysis) {
    const value = analysis['extractedText'];
    return typeof value === 'string' ? value : null;
  }
  return undefined;
}

/**
 * The category names of the run.
 *
 * The top-level `categories[]` is authoritative when present; categories
 * observed on the records fill the gaps (a partial cache records no taxonomy,
 * but the labels it produced are still real data).
 */
function collectCategoryNames(
  object: Record<string, unknown>,
  images: readonly LegacyImageRecord[],
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined): void => {
    if (!name) return;
    const trimmed = name.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    names.push(trimmed);
  };

  for (const name of asStringArray(object['categories'])) push(name);
  for (const image of images) push(image.category);

  return names;
}

/** Normalizes the legacy `sessions[]` array. */
function normalizeSessions(value: unknown): LegacySessionRecord[] {
  if (!Array.isArray(value)) return [];
  const sessions: LegacySessionRecord[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const sessionId = asNumber(entry['sessionId']);
    if (sessionId === undefined) continue;
    sessions.push({
      sessionId,
      startMs: asNumber(entry['startMs']),
      endMs: asNumber(entry['endMs']),
      imageNumbers: asNumberArray(entry['imageNumbers']),
    });
  }
  return sessions;
}

/** Normalizes the legacy `overrides[]` array (the human review history). */
function normalizeOverrides(value: unknown): LegacyOverrideRecord[] {
  if (!Array.isArray(value)) return [];
  const overrides: LegacyOverrideRecord[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    overrides.push({
      file: asString(entry['file']),
      originalCategory: asString(entry['originalCategory']),
      overriddenCategory: asString(entry['overriddenCategory']),
    });
  }
  return overrides;
}

/** Reads an array of finite numbers. */
function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
}

/**
 * The bare file name of a path-like value.
 *
 * Legacy records store BARE names, but a hand-edited file could contain a
 * path. The importer only ever joins a bare name onto a known root, so the
 * directory part is dropped here (see the importer's `resolveWithinRoot`).
 */
export function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
