/**
 * The gold split generator over the REAL upstream VisA data.
 *
 * The upstream `image_anno.csv` differs from the repository's synthetic
 * fixture in three ways that a naive reader gets wrong (the fixtures in
 * `fixtures/visa-upstream/` reproduce them):
 *
 *  1. the `image` cell is **part-prefixed** and relative to the DATASET ROOT
 *     (`candle/Data/Images/Normal/0000.JPG`), not to the CSV's own directory;
 *  2. the `label` cell of an ANOMALOUS image is the **defect type name**
 *     (`chunk of wax missing`), not the word `anomaly` — and it may be a
 *     quoted, comma-separated list of several defect names;
 *  3. there is no `session`, no `defect_type` and no `class` column.
 *
 * What is proven here:
 *  - both path conventions resolve, and an ambiguous or missing image is a
 *    LOUD error naming the CSV, the cell and the resolved absolute paths;
 *  - the upstream defect-type vocabulary maps to `anomalous`, cross-checked
 *    against the image's own `Data/Images/{Normal,Anomaly}` directory — a
 *    disagreement between the two is a hard error, never a silent pick;
 *  - `--target-images` selects exactly the images the normaliser selects for
 *    the same tree (the gold manifest and the store describe one subset).
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeVisaSubset } from '../../src/benchmark/normalize.js';
import { openMigratedStore } from '../../src/store/index.js';
import {
  enumerateSplitItems,
  mapLabelToAnomaly,
  resolveImageCell,
} from '../../../../scripts/benchmarks/make-splits.js';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'visa-upstream',
);

/** 1x1 PNG — the split generator hashes image bytes, it never decodes them. */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

/** A tiny temporary directory the caller must remove. */
function makeTempDir(prefix = 'mv-splits-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Writes a placeholder image whose bytes are unique per path. */
function writeImage(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const salt = createHash('sha256').update(filePath).digest('hex').substring(0, 8);
  writeFileSync(filePath, Buffer.concat([PNG_BYTES, Buffer.from(salt)]));
}

/**
 * The `image` cells of a fixture CSV, in file order.
 *
 * The image cell is the first column and never contains a comma, so the plain
 * split is safe here (the LABEL cell may contain commas — that is what the
 * quoting is about).
 */
function imageCellsOf(csvPath: string): string[] {
  return readFileSync(csvPath, 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(',')[0]!.trim());
}

/**
 * Builds a dataset root that holds the given fixture parts.
 *
 * The `image` cell of a fixture CSV names the SAME file under both
 * conventions — it is either part-prefixed (the upstream convention,
 * `candle/Data/Images/Normal/0000.JPG`) or relative to the CSV's own
 * directory (the synthetic-fixture convention,
 * `Data/Images/Normal/0000.JPG`). The tree therefore always holds the file at
 * `<root>/<part>/<cell without the part prefix>`; only the TEXT of the cell
 * differs, and that is what the resolver has to cope with.
 */
function buildUpstreamTree(parts: readonly string[]): string {
  const root = makeTempDir('mv-splits-tree-');
  for (const part of parts) {
    const fixtureCsv = path.join(FIXTURES_DIR, part, 'image_anno.csv');
    const partDir = path.join(root, part);
    mkdirSync(partDir, { recursive: true });
    copyFileSync(fixtureCsv, path.join(partDir, 'image_anno.csv'));
    for (const cell of imageCellsOf(fixtureCsv)) {
      const bare = cell.startsWith(`${part}/`) ? cell.slice(part.length + 1) : cell;
      writeImage(path.join(root, part, bare));
    }
  }
  return root;
}

describe('the upstream VisA CSV shape', () => {
  it('resolves a part-prefixed image cell against the dataset root', async () => {
    const root = buildUpstreamTree(['candle']);
    try {
      const csvPath = path.join(root, 'candle', 'image_anno.csv');
      const resolved = await resolveImageCell(root, csvPath, 'candle/Data/Images/Normal/0000.JPG');
      expect(resolved).toBe(path.join(root, 'candle', 'Data', 'Images', 'Normal', '0000.JPG'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a CSV-directory-relative image cell against the CSV directory', async () => {
    const root = buildUpstreamTree(['capsules']);
    try {
      const csvPath = path.join(root, 'capsules', 'image_anno.csv');
      const resolved = await resolveImageCell(root, csvPath, 'Data/Images/Normal/0000.JPG');
      expect(resolved).toBe(path.join(root, 'capsules', 'Data', 'Images', 'Normal', '0000.JPG'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('FAILS LOUDLY when the cell resolves to two different images', async () => {
    const root = buildUpstreamTree(['capsules']);
    try {
      // The root-relative interpretation of the cell now exists as well.
      writeImage(path.join(root, 'Data', 'Images', 'Normal', '0000.JPG'));
      const csvPath = path.join(root, 'capsules', 'image_anno.csv');
      await expect(
        resolveImageCell(root, csvPath, 'Data/Images/Normal/0000.JPG'),
      ).rejects.toThrow(/ambiguous/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('FAILS LOUDLY when the cell resolves to no image at all', async () => {
    const root = buildUpstreamTree(['candle']);
    try {
      const csvPath = path.join(root, 'candle', 'image_anno.csv');
      await expect(
        resolveImageCell(root, csvPath, 'candle/Data/Images/Normal/9999.JPG'),
      ).rejects.toThrow(/does not exist/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the upstream label vocabulary', () => {
  it('maps the defect-type vocabulary to anomalous', () => {
    expect(mapLabelToAnomaly('chunk of wax missing', 'Data/Images/Anomaly/000.JPG')).toBe(
      'anomalous',
    );
    expect(mapLabelToAnomaly('normal', 'Data/Images/Normal/0000.JPG')).toBe('normal');
  });

  it('keeps the defect-type text available on the item', async () => {
    const root = buildUpstreamTree(['candle']);
    try {
      const items = await enumerateSplitItems({ root, layout: 'visa' });
      const anomaly = items.find((item) => item.path.endsWith('Anomaly/000.JPG'));
      expect(anomaly?.anomaly).toBe('anomalous');
      expect(anomaly?.defectType).toBe('chunk of wax missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('FAILS LOUDLY when the label contradicts the image directory', () => {
    expect(() =>
      mapLabelToAnomaly('normal', 'Data/Images/Anomaly/000.JPG'),
    ).toThrow(/normal.*Anomaly|Anomaly.*normal/s);
  });

  it('FAILS LOUDLY when the path names BOTH a Normal and an Anomaly directory', () => {
    // A path that contradicts itself must not silently DISABLE the
    // cross-check: that is exactly the case the check exists to catch.
    expect(() =>
      mapLabelToAnomaly('chunk of wax missing', 'Data/Images/Anomaly/Normal/000.JPG'),
    ).toThrow(/BOTH a Normal and an Anomaly/);
  });

  it('lets the label decide when the path carries no Normal/Anomaly segment', () => {
    expect(mapLabelToAnomaly('chunk of wax missing', 'flat/000.JPG')).toBe('anomalous');
    expect(mapLabelToAnomaly('normal', 'flat/000.JPG')).toBe('normal');
  });

  it('refuses an empty label outright', () => {
    expect(() => mapLabelToAnomaly('', 'flat/000.JPG')).toThrow(/empty/i);
  });
});

describe('an image the CSV names with an empty label', () => {
  it('is split as anomalous without a defect type — like the store', async () => {
    const root = makeTempDir('mv-splits-empty-');
    const partDir = path.join(root, 'candle');
    mkdirSync(partDir, { recursive: true });
    writeFileSync(
      path.join(partDir, 'image_anno.csv'),
      'image,label,mask\ncandle/Data/Images/Anomaly/000.JPG,,\n',
      'utf8',
    );
    writeImage(path.join(root, 'candle', 'Data', 'Images', 'Anomaly', '000.JPG'));

    const dbDir = makeTempDir('mv-splits-db-');
    const store = await openMigratedStore(path.join(dbDir, 'store.db'));
    try {
      const report = await normalizeVisaSubset({ db: store.db, visaRoot: root, targetImages: 1 });
      // The store keys an image with an empty label cell 'defect:unlabeled'.
      expect(report.normalizedSamples[0]?.labelKey).toBe('defect:unlabeled');

      const items = await enumerateSplitItems({ root, layout: 'visa', targetImages: 1 });
      expect(items).toHaveLength(1);
      expect(items[0]?.anomaly).toBe('anomalous');
      expect(items[0]?.defectType).toBeUndefined();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe('the subset selection of the real data', () => {
  it('selects exactly the images the normaliser selects for the same tree', async () => {
    const root = buildUpstreamTree(['candle', 'capsules']);
    const dbDir = makeTempDir('mv-splits-db-');
    const store = await openMigratedStore(path.join(dbDir, 'store.db'));
    try {
      const report = await normalizeVisaSubset({
        db: store.db,
        visaRoot: root,
        targetImages: 7,
      });
      const storePaths = report.normalizedSamples
        .map((sample) => path.relative(root, sample.path))
        .sort();

      const items = await enumerateSplitItems({ root, layout: 'visa', targetImages: 7 });
      const itemPaths = items.map((item) => item.path).sort();

      expect(itemPaths).toEqual(storePaths);
      expect(itemPaths).toHaveLength(7);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
