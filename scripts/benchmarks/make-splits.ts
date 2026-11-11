/**
 * Gold split generator CLI — spec 003, US2 (FR-003).
 *
 * Enumerates the items of a dataset root (with their sha256 and their
 * class/anomaly labels), generates the seeded, stratified gold split
 * manifest and writes it byte-stably.
 *
 * Usage:
 *   pnpm exec tsx scripts/benchmarks/make-splits.ts \
 *     --dataset visa-subset --root datasets/visa-subset --seed 42 \
 *     --target-images 700 \
 *     --out benchmarks/splits/visa-subset.gold.json
 *
 * Layouts
 *   visa (default) — one directory per class (VisA part) under --root, each
 *                    holding an `image_anno.csv`.
 *   flat           — a single `image_anno.csv` directly under --root; the
 *                    class comes from the CSV `class` column (or --dataset).
 *
 * `image_anno.csv` columns (VisA shape):
 *   image       REQUIRED  path of the image. It is resolved against the
 *                        DATASET ROOT and against the CSV's own directory;
 *                        an ambiguous or missing image is a LOUD error.
 *   label       REQUIRED  `normal` | `anomaly` (mapped to `anomalous`) — or
 *                        the upstream DEFECT-TYPE name (`chunk of wax missing`),
 *                        which is mapped to `anomalous` and kept as
 *                        `defectType` on the item.
 *   mask        optional   path of the mask image (not used by the split).
 *   defect_type optional   defect taxonomy key (not used by the split).
 *   session     optional   capture-session key. Items sharing a session are
 *                           NEVER split across train/val/test (the
 *                           leakage-aware unit of the research file). When
 *                           the column is absent the whole class collapses
 *                           into one capture group — use --groups-file for
 *                           the real VisA run, whose sessions come from the
 *                           normalized store (spec 003 US1).
 *   class       optional   class label (flat layout only).
 *
 * ## The subset (--target-images)
 *
 * Without `--target-images` EVERY row of every `image_anno.csv` is split.
 * With `--target-images <n>` the generator selects the SAME images the
 * normaliser selects for the same tree: the selection is shared code
 * (`collectVisaPartData` + `selectVisaSubsetImages`), so the gold manifest
 * and the normalized store describe ONE subset. A manifest that disagreed
 * with the store would score images the store does not have.
 *
 * The manifest carries NO timestamp: a timestamp would break the byte-stable
 * regeneration SC-001 demands. Use --meta to write a sidecar with the
 * generation date instead.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  collectVisaPartData,
  listPartDirectories,
  selectVisaSubsetImages,
} from '../../packages/core/src/benchmark/normalize.js';
import {
  generateSplitManifest,
  serializeSplitManifest,
  type AnomalyLabel,
  type SplitItem,
  type SplitNote,
  type SplitRatios,
} from '../../packages/core/src/benchmark/splits.js';

const USAGE = `Usage:
  tsx scripts/benchmarks/make-splits.ts --dataset <id> --root <dir> --out <file> [options]

Options:
  --dataset <id>        dataset id recorded in the manifest (e.g. visa-subset)
  --root <dir>          dataset root to enumerate
  --out <file>          manifest output path
  --seed <n>            split seed (default 42)
  --id <manifest id>    manifest id (default: <dataset>.gold)
  --layout <visa|flat>  dataset layout (default: visa)
  --target-images <n>   split the subset the normaliser selects for the same
                        tree (visa layout only) instead of every CSV row
  --parts <a,b,c>       only these object classes (mirrors
                        normalize-visa.ts --parts)
  --ratios <t,v,t>      train/val/test ratios (default: 0.6,0.2,0.2)
  --notes <file>        JSON array of {id, reason} — known-bad items
  --groups-file <file>  JSON map of relative image path -> capture-group key
  --meta                also write <out>.meta.json (generation date sidecar)
`;

interface ParsedCsv {
  header: string[];
  rows: string[][];
}

/** Minimal CSV reader (quoted fields, CRLF, blank lines). */
function parseCsv(text: string): ParsedCsv {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);
  const [header = [], ...rows] = lines;
  return { header, rows };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current.trim());
  return fields;
}

/**
 * One row of an `image_anno.csv`, with its columns resolved.
 */
interface AnnotationRow {
  /** The `image` cell, verbatim. */
  readonly image: string;
  /** The `label` cell, verbatim. */
  readonly label: string;
  /** The `mask` cell (empty when the column or the value is absent). */
  readonly mask: string;
  /** The `session` cell (empty when the column or the value is absent). */
  readonly session: string;
  /** The `class` cell (empty when the column or the value is absent). */
  readonly class: string;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** One enumerated item of the split. */
export interface EnumeratedSplitItem extends SplitItem {
  /** Capture-group key derived from the CSV (or the class when absent). */
  captureGroup?: string;
  /**
   * The upstream defect-type text of the row (`chunk of wax missing`),
   * when the label carries one. Empty for the generic `normal`/`anomaly`
   * markers — those name no defect.
   */
  defectType?: string;
}

/** The options of one enumeration. */
export interface EnumerateSplitItemsOptions {
  /** The dataset root the manifest paths are relative to. */
  readonly root: string;
  /** The layout of the dataset root. */
  readonly layout: 'visa' | 'flat';
  /** An explicit capture-group key per root-relative image path. */
  readonly groupsOverride?: ReadonlyMap<string, string>;
  /**
   * The number of images of the subset. When given, the selection of the
   * normaliser is used (shared code), so the manifest and the store describe
   * one subset. Without it, every row of every CSV is split.
   */
  readonly targetImages?: number;
  /**
   * The object classes to enumerate. Defaults to every class found under the
   * root; it mirrors `normalize-visa.ts --parts`, so a part-restricted
   * normalisation and a part-restricted manifest describe the same subset.
   */
  readonly parts?: readonly string[];
}

async function fileSha256(absolutePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(absolutePath))
    .digest('hex');
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the `image` cell of an annotation row to a file on disk.
 *
 * The upstream VisA CSV writes the cell **relative to the dataset root**
 * (`candle/Data/Images/Normal/0000.JPG`), while the repository's synthetic
 * fixture writes it **relative to the CSV's own directory**
 * (`Data/Images/Normal/0000.JPG`). Both are tried.
 *
 * A cell that resolves to TWO different files is ambiguous and a cell that
 * resolves to NONE is dangling — both are loud errors: a silently picked
 * interpretation would split images the benchmark never scored.
 *
 * @param root - the dataset root.
 * @param csvPath - the annotation CSV the cell came from.
 * @param cell - the `image` cell, verbatim.
 */
export async function resolveImageCell(
  root: string,
  csvPath: string,
  cell: string,
): Promise<string> {
  const candidates = [...new Set([path.resolve(root, cell), path.resolve(path.dirname(csvPath), cell)])];
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) found.push(candidate);
  }
  if (found.length === 0) {
    throw new Error(
      `${csvPath}: image '${cell}' does not exist (tried ${candidates
        .map((candidate) => `'${candidate}'`)
        .join(' and ')})`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `${csvPath}: image '${cell}' is ambiguous — it resolves to more than one file: ` +
        `${found.map((candidate) => `'${candidate}'`).join(' and ')}`,
    );
  }
  return found[0]!;
}

/**
 * What the image's own path says about it.
 *
 * - `none`    — the path carries no `Normal`/`Anomaly` segment, so the
 *               directory cannot corroborate the label;
 * - `value`   — the path names one bucket;
 * - `conflict`— the path names BOTH buckets, which is impossible for one
 *               image. Silently treating that as "no information" would
 *               disable the cross-check exactly where it matters most, so it
 *               is reported as the contradiction it is.
 */
type PathAnomaly =
  | { readonly kind: 'none' }
  | { readonly kind: 'value'; readonly anomaly: AnomalyLabel }
  | { readonly kind: 'conflict' };

function anomalyFromPath(relativePath: string): PathAnomaly {
  let result: AnomalyLabel | null = null;
  for (const segment of relativePath.split(/[\\/]/)) {
    const lowered = segment.toLowerCase();
    if (lowered !== 'normal' && lowered !== 'anomaly') continue;
    const anomaly: AnomalyLabel = lowered === 'normal' ? 'normal' : 'anomalous';
    if (result !== null && result !== anomaly) return { kind: 'conflict' };
    result = anomaly;
  }
  return result === null ? { kind: 'none' } : { kind: 'value', anomaly: result };
}

/**
 * Maps a raw annotation label onto the anomaly label of the split.
 *
 * The upstream vocabulary is NOT `normal`/`anomaly`: the label of an
 * anomalous image is its DEFECT TYPE (`chunk of wax missing`, `bubble`,
 * `bent,melt`), and it may be a quoted, comma-separated list of several
 * defect names. Every label that is not a plain `normal` therefore means
 * `anomalous`, and the text itself is kept on the item as `defectType`.
 *
 * The label is cross-checked against the directory the image sits in
 * (`Data/Images/Normal` vs `Data/Images/Anomaly`). A disagreement is a hard
 * error: the two sources describe the same image and one of them is wrong,
 * and a silent pick would put an image into the wrong split.
 *
 * @param label - the `label` cell, verbatim.
 * @param relativePath - the path of the image, relative to the dataset root.
 */
export function mapLabelToAnomaly(label: string, relativePath: string): AnomalyLabel {
  const trimmed = label.trim();
  const lowered = trimmed.toLowerCase();
  let fromLabel: AnomalyLabel;
  if (lowered === 'normal' || lowered === 'good') {
    fromLabel = 'normal';
  } else if (lowered === 'anomaly' || lowered === 'anomalous' || lowered === 'defect') {
    fromLabel = 'anomalous';
  } else if (lowered.length > 0) {
    // The upstream defect-type vocabulary.
    fromLabel = 'anomalous';
  } else {
    throw new Error(`the label of '${relativePath}' is empty — it carries no ground truth`);
  }

  const fromPath = anomalyFromPath(relativePath);
  if (fromPath.kind === 'conflict') {
    throw new Error(
      `the path '${relativePath}' names BOTH a Normal and an Anomaly directory — ` +
        `the image's own location contradicts itself (the label says ${fromLabel})`,
    );
  }
  if (fromPath.kind === 'value' && fromPath.anomaly !== fromLabel) {
    throw new Error(
      `label '${trimmed}' contradicts the image directory '${relativePath}' — ` +
        `the Normal/Anomaly directory says ${fromPath.anomaly}, the label says ${fromLabel}`,
    );
  }
  return fromLabel;
}

/**
 * The defect-type text of a label, or `undefined` when the label names no
 * defect (the generic `normal`/`anomaly` markers).
 */
function defectTypeOf(label: string): string | undefined {
  const trimmed = label.trim();
  const lowered = trimmed.toLowerCase();
  if (
    lowered.length === 0 ||
    lowered === 'normal' ||
    lowered === 'good' ||
    lowered === 'anomaly' ||
    lowered === 'anomalous' ||
    lowered === 'defect'
  ) {
    return undefined;
  }
  return trimmed;
}

/** Reads the rows of an `image_anno.csv`, with their columns resolved. */
async function readAnnotationRows(csvPath: string): Promise<AnnotationRow[]> {
  const { header, rows } = parseCsv(await readFile(csvPath, 'utf8'));
  const columns = header.map((name) => name.trim().toLowerCase());
  const imageColumn = columns.indexOf('image');
  const labelColumn = columns.indexOf('label');
  if (imageColumn < 0 || labelColumn < 0) {
    throw new Error(
      `${csvPath}: 'image' and 'label' columns are required (found: ${header.join(', ')})`,
    );
  }
  const maskColumn = columns.indexOf('mask');
  const sessionColumn = columns.indexOf('session');
  const classColumn = columns.indexOf('class');

  const parsed: AnnotationRow[] = [];
  for (const row of rows) {
    const image = (row[imageColumn] ?? '').trim();
    if (image.length === 0) continue;
    parsed.push({
      image,
      label: (row[labelColumn] ?? '').trim(),
      mask: maskColumn >= 0 ? (row[maskColumn] ?? '').trim() : '',
      session: sessionColumn >= 0 ? (row[sessionColumn] ?? '').trim() : '',
      class: classColumn >= 0 ? (row[classColumn] ?? '').trim() : '',
    });
  }
  return parsed;
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

/** Enumerate the items of one `image_anno.csv` — every row of it. */
async function enumerateCsv(
  csvPath: string,
  className: string,
  root: string,
  groupsOverride: ReadonlyMap<string, string>,
): Promise<EnumeratedSplitItem[]> {
  const items: EnumeratedSplitItem[] = [];
  for (const row of await readAnnotationRows(csvPath)) {
    if (row.label.length === 0) continue;

    const absolute = await resolveImageCell(root, csvPath, row.image);
    const relative = toPosix(path.relative(root, absolute));
    const rowClass = row.class.length > 0 ? row.class : className;
    const group =
      groupsOverride.get(relative) ?? (row.session ? `${rowClass}::${row.session}` : rowClass);

    items.push({
      id: relative,
      class: rowClass,
      anomaly: mapLabelToAnomaly(row.label, relative),
      group,
      captureGroup: group,
      defectType: defectTypeOf(row.label),
      sha256: await fileSha256(absolute),
      path: relative,
    });
  }
  return items;
}

/** Enumerate every row of every annotation CSV of the dataset root. */
async function enumerateEveryRow(
  root: string,
  layout: 'visa' | 'flat',
  groupsOverride: ReadonlyMap<string, string>,
): Promise<EnumeratedSplitItem[]> {
  const items: EnumeratedSplitItem[] = [];

  if (layout === 'flat') {
    const csvPath = path.join(root, 'image_anno.csv');
    if (!(await exists(csvPath))) {
      throw new Error(`no image_anno.csv found at ${csvPath}`);
    }
    items.push(...(await enumerateCsv(csvPath, path.basename(root), root, groupsOverride)));
    return items;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    const classDir = path.join(root, entry.name);
    const csvPath = path.join(classDir, 'image_anno.csv');
    if (!(await exists(csvPath))) continue;
    items.push(...(await enumerateCsv(csvPath, entry.name, root, groupsOverride)));
  }

  if (items.length === 0) {
    throw new Error(`no class directory with an image_anno.csv found under ${root}`);
  }
  return items;
}

/**
 * Resolves every annotation row of every part to the file it names.
 *
 * Every cell of every CSV is resolved — a cell that is missing or ambiguous
 * is a loud error, even when the row is outside the selected subset.
 */
async function resolvePartCsvRows(
  root: string,
  parts: readonly string[],
): Promise<Map<string, AnnotationRow>> {
  const resolved = new Map<string, AnnotationRow>();
  for (const part of parts) {
    const csvPath = await findAnnotationCsv(path.join(root, part));
    if (csvPath === null) continue;
    for (const row of await readAnnotationRows(csvPath)) {
      const absolute = await resolveImageCell(root, csvPath, row.image);
      const previous = resolved.get(absolute);
      if (previous !== undefined) {
        throw new Error(
          `${csvPath}: image '${row.image}' is listed more than once ` +
            `(both rows resolve to '${absolute}')`,
        );
      }
      resolved.set(absolute, row);
    }
  }
  return resolved;
}

/**
 * Enumerates the SUBSET the normaliser selects for the same tree.
 *
 * The selection itself is shared code (`collectVisaPartData` +
 * `selectVisaSubsetImages`), so the manifest and the store describe one
 * subset. The labels come from the same map the store was filled from, and
 * every annotation cell of the tree is resolved and cross-checked against it
 * — a disagreement is a loud error, not a silent pick.
 *
 * The capture group of an item is its object class: that is the capture
 * session the store groups it under (one session per VisA part), so the
 * split never separates two images of the same session.
 */
async function enumerateSubset(
  root: string,
  target: number,
  groupsOverride: ReadonlyMap<string, string>,
  onlyParts?: readonly string[],
): Promise<EnumeratedSplitItem[]> {
  const available = await listPartDirectories(root);
  if (available.length === 0) {
    throw new Error(`no VisA object class directories found under '${root}'`);
  }
  // An explicit part list mirrors `normalize-visa.ts --parts`: the manifest
  // then describes the SAME subset as a part-restricted normalisation.
  const parts = onlyParts === undefined || onlyParts.length === 0 ? available : [...onlyParts].sort();
  for (const part of parts) {
    if (!available.includes(part)) {
      throw new Error(
        `the object class '${part}' is not present under '${root}' (found: ${available.join(', ')})`,
      );
    }
  }

  const partData = await collectVisaPartData(root, parts);
  const csvRows = await resolvePartCsvRows(root, parts);
  const selected = selectVisaSubsetImages(partData, target);

  const items: EnumeratedSplitItem[] = [];
  const unlabeled: string[] = [];
  for (const entry of selected) {
    const absolute = entry.image.absolutePath;
    const relative = toPosix(path.relative(root, absolute));
    const row = csvRows.get(absolute);
    const label = entry.label;

    if (label === undefined && row !== undefined) {
      throw new Error(
        `${absolute}: the annotation CSV names this image, but the normaliser did not ` +
          'match it to a label — the CSV path convention and the dataset layout disagree',
      );
    }
    if (label !== undefined && row !== undefined && row.label !== label) {
      throw new Error(
        `${absolute}: the annotation CSV says label '${row.label}', the normaliser read '${label}'`,
      );
    }
    if (label === undefined && entry.image.anomalous) {
      // An anomalous image without a label has no ground truth to be scored
      // against; the normaliser leaves it out of the store, so the split
      // leaves it out too.
      continue;
    }

    // An EMPTY label cell is not the same as a missing one: the CSV names the
    // image, and the store keys it 'defect:unlabeled' — an anomaly without a
    // defect type. The manifest says the same thing ('anomalous', no
    // defectType), and the operator is told about it.
    const emptyLabel = label !== undefined && label.trim().length === 0;
    const effectiveLabel = label ?? 'normal';
    // The empty label cell is an anomaly without a defect type (the store
    // keys it 'defect:unlabeled'), and the DIRECTORY still has the final
    // word: an empty label on an image that sits in the Normal bucket is a
    // contradiction, not an anomaly.
    const anomaly: AnomalyLabel = emptyLabel
      ? assertDirectorySaysAnomaly(entry.image.relativePath, effectiveLabel)
      : mapLabelToAnomaly(effectiveLabel, entry.image.relativePath);
    if (emptyLabel) unlabeled.push(relative);

    const group = groupsOverride.get(relative) ?? entry.part;
    items.push({
      id: relative,
      class: entry.part,
      anomaly,
      group,
      captureGroup: group,
      defectType: defectTypeOf(effectiveLabel),
      sha256: await fileSha256(absolute),
      path: relative,
    });
  }
  if (unlabeled.length > 0) {
    console.warn(
      `[make-splits] ${unlabeled.length} image(s) carry an EMPTY label cell — they are ` +
        `split as 'anomalous' without a defect type (the store keys them 'defect:unlabeled')`,
    );
  }
  return items;
}

/**
 * The anomaly an empty label cell implies, cross-checked against the image's
 * own directory.
 *
 * @throws when the directory says the image is normal — an empty label on a
 *   normal image is a contradiction, not an anomaly.
 */
function assertDirectorySaysAnomaly(relativePath: string, label: string): AnomalyLabel {
  const fromPath = anomalyFromPath(relativePath);
  if (fromPath.kind === 'conflict') {
    throw new Error(
      `the path '${relativePath}' names BOTH a Normal and an Anomaly directory — ` +
        'the image\'s own location contradicts itself',
    );
  }
  if (fromPath.kind === 'value' && fromPath.anomaly !== 'anomalous') {
    throw new Error(
      `the empty label of '${relativePath}' contradicts the image directory — ` +
        `the directory says ${fromPath.anomaly}, an empty label cell means an anomaly ` +
        `(the label cell was '${label}')`,
    );
  }
  return 'anomalous';
}

/**
 * Enumerates the items of a dataset root.
 *
 * @throws {Error} when an image cell is ambiguous or missing, when a label
 *   contradicts the directory of its image, or when the dataset root holds no
 *   annotation CSV at all.
 */
export async function enumerateSplitItems(
  options: EnumerateSplitItemsOptions,
): Promise<EnumeratedSplitItem[]> {
  const root = path.resolve(options.root);
  const groupsOverride = options.groupsOverride ?? new Map<string, string>();
  if (options.targetImages !== undefined) {
    if (options.layout !== 'visa') {
      throw new Error(
        '--target-images is only supported for the "visa" layout — a flat dataset ' +
          'has no object classes to subset',
      );
    }
    return enumerateSubset(root, options.targetImages, groupsOverride, options.parts);
  }
  return enumerateEveryRow(root, options.layout, groupsOverride);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string' },
      root: { type: 'string' },
      out: { type: 'string' },
      seed: { type: 'string' },
      id: { type: 'string' },
      layout: { type: 'string' },
      'target-images': { type: 'string' },
      parts: { type: 'string' },
      ratios: { type: 'string' },
      notes: { type: 'string' },
      'groups-file': { type: 'string' },
      meta: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (!values.dataset || !values.root || !values.out) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const layout = values.layout === 'flat' ? 'flat' : 'visa';
  const seed = values.seed ? Number.parseInt(values.seed, 10) : 42;
  if (!Number.isFinite(seed)) {
    throw new Error(`--seed must be an integer (got '${values.seed}')`);
  }

  let targetImages: number | undefined;
  if (values['target-images'] !== undefined) {
    targetImages = Number.parseInt(values['target-images'], 10);
    if (!Number.isFinite(targetImages) || targetImages <= 0) {
      throw new Error(`--target-images must be a positive integer (got '${values['target-images']}')`);
    }
  }

  const parts =
    values.parts === undefined
      ? undefined
      : values.parts
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);

  const ratios: SplitRatios = values.ratios
    ? (() => {
        const parts = values.ratios.split(',').map((part) => Number.parseFloat(part.trim()));
        if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
          throw new Error(`--ratios must be "train,val,test" (got '${values.ratios}')`);
        }
        return { train: parts[0], val: parts[1], test: parts[2] };
      })()
    : { train: 0.6, val: 0.2, test: 0.2 };

  const groupsOverride = values['groups-file']
    ? new Map(Object.entries(await readJson<Record<string, string>>(values['groups-file'])))
    : new Map<string, string>();

  const notes = values.notes ? await readJson<SplitNote[]>(values.notes) : [];

  const root = path.resolve(values.root);
  const items = await enumerateSplitItems({
    root,
    layout,
    groupsOverride,
    targetImages,
    ...(parts === undefined ? {} : { parts }),
  });

  const manifest = generateSplitManifest({
    id: values.id ?? `${values.dataset}.gold`,
    datasetId: values.dataset,
    seed,
    items,
    notes,
    ratios,
  });

  const outPath = path.resolve(values.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, serializeSplitManifest(manifest), 'utf8');

  if (values.meta) {
    const sidecar = {
      generatedAt: new Date().toISOString(),
      generator: 'scripts/benchmarks/make-splits.ts',
      manifestId: manifest.id,
      datasetId: manifest.datasetId,
      seed: manifest.seed,
      manifestHash: manifest.manifestHash,
      note: 'Sidecar only — the manifest itself carries no timestamp (SC-001 byte-stability).',
    };
    await writeFile(`${outPath}.meta.json`, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  }

  console.log(`[make-splits] ${manifest.assignments.length} items -> ${outPath}`);
  console.log(
    `[make-splits] manifest id: ${manifest.id} (dataset ${manifest.datasetId}, seed ${seed})`,
  );
  if (targetImages !== undefined) {
    console.log(
      `[make-splits] subset: the ${targetImages} images the normaliser selects for this tree`,
    );
  }
  console.log(`[make-splits] manifestHash: ${manifest.manifestHash}`);
  for (const stratum of manifest.strata) {
    console.log(
      `[make-splits]   ${stratum.class}/${stratum.anomaly}: total ${stratum.total} ` +
        `-> train ${stratum.train} / val ${stratum.val} / test ${stratum.test}`,
    );
  }
  if (manifest.notes.length > 0) {
    console.log(`[make-splits] ${manifest.notes.length} note(s) recorded (known-bad / overflow)`);
  }
}

// Only run when invoked as a script, never when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('[make-splits] Error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
