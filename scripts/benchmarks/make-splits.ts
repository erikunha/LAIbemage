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
 *     --out benchmarks/splits/visa-subset.gold.json
 *
 * Layouts
 *   visa (default) — one directory per class (VisA part) under --root, each
 *                    holding an `image_anno.csv`.
 *   flat           — a single `image_anno.csv` directly under --root; the
 *                    class comes from the CSV `class` column (or --dataset).
 *
 * `image_anno.csv` columns (VisA shape):
 *   image       REQUIRED  path of the image, relative to the CSV directory.
 *   label       REQUIRED  `normal` | `anomaly` (mapped to `anomalous`).
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
 * The manifest carries NO timestamp: a timestamp would break the byte-stable
 * regeneration SC-001 demands. Use --meta to write a sidecar with the
 * generation date instead.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
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

function toAnomaly(label: string): AnomalyLabel {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'normal' || normalized === 'good') return 'normal';
  if (normalized === 'anomaly' || normalized === 'anomalous' || normalized === 'defect') {
    return 'anomalous';
  }
  throw new Error(`unknown label '${label}' (expected 'normal' or 'anomaly')`);
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

interface EnumeratedItem extends SplitItem {
  /** Capture-group key derived from the CSV (or the class when absent). */
  captureGroup?: string;
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

/** Enumerate the items of one `image_anno.csv`. */
async function enumerateCsv(
  csvPath: string,
  className: string,
  root: string,
  groupsOverride: Map<string, string>,
): Promise<EnumeratedItem[]> {
  const csvDir = path.dirname(csvPath);
  const { header, rows } = parseCsv(await readFile(csvPath, 'utf8'));
  const indexOf = (name: string): number => header.indexOf(name);
  const imageColumn = indexOf('image');
  const labelColumn = indexOf('label');
  if (imageColumn < 0 || labelColumn < 0) {
    throw new Error(
      `${csvPath}: 'image' and 'label' columns are required (found: ${header.join(', ')})`,
    );
  }
  const sessionColumn = indexOf('session');
  const classColumn = indexOf('class');

  const items: EnumeratedItem[] = [];
  for (const row of rows) {
    const imageField = row[imageColumn];
    if (!imageField) continue;
    const labelField = row[labelColumn];
    if (!labelField) continue;

    const absolute = path.resolve(csvDir, imageField);
    if (!(await exists(absolute))) {
      throw new Error(`${csvPath}: image '${imageField}' does not exist (${absolute})`);
    }
    const relative = toPosix(path.relative(root, absolute));
    const rowClass = classColumn >= 0 && row[classColumn] ? row[classColumn] : className;
    const session = sessionColumn >= 0 ? row[sessionColumn] : '';

    items.push({
      id: relative,
      class: rowClass,
      anomaly: toAnomaly(labelField),
      group: groupsOverride.get(relative) ?? (session ? `${rowClass}::${session}` : rowClass),
      captureGroup:
        groupsOverride.get(relative) ?? (session ? `${rowClass}::${session}` : rowClass),
      sha256: await fileSha256(absolute),
      path: relative,
    });
  }
  return items;
}

async function enumerateDataset(
  root: string,
  layout: 'visa' | 'flat',
  groupsOverride: Map<string, string>,
): Promise<EnumeratedItem[]> {
  const items: EnumeratedItem[] = [];

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
  const items = await enumerateDataset(root, layout, groupsOverride);

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

main().catch((error: unknown) => {
  console.error('[make-splits] Error:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
