import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFECT_LABEL_PREFIX,
  NORMAL_LABEL_KEY,
  mapVisaLabel,
  normalizeVisaSubset,
  parseVisaAnnotationCsv,
} from '../../src/benchmark/normalize.js';
import { openMigratedStore } from '../../src/store/index.js';

/**
 * The VisA → 002 normalisation (spec 003, US1 / task 1.3).
 *
 * These tests run against a REAL SQLite store (a temporary file, never the
 * user's home directory) and a SYNTHETIC VisA tree — no network, no dataset
 * download, no 1.93 GB archive. The synthetic tree is shaped exactly like the
 * real one:
 *
 * ```text
 * VisA/<part>/Data/Images/Normal/*.JPG
 * VisA/<part>/Data/Images/Anomaly/*.JPG
 * VisA/<part>/image_anno.csv        (image,label,mask)
 * ```
 */

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

/** A tiny temporary directory the caller must remove. */
function makeTempDir(prefix = 'mv-visa-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * Writes a 1x1 PNG at the given path.
 *
 * The bytes are salted with the path, so every synthetic image has its own
 * sha256: the store deduplicates assets by digest, and two identical images
 * would collapse into a single asset row.
 */
function writeImage(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const salt = createHash('sha256').update(filePath).digest().subarray(0, 8);
  writeFileSync(filePath, Buffer.concat([PNG_BYTES, salt]));
}

/** One part of a synthetic VisA tree. */
interface PartSpec {
  /** The object class name. */
  readonly part: string;
  /** How many normal images to create. */
  readonly normals: number;
  /** How many anomalous images to create. */
  readonly anomalies: number;
  /** The label of the anomalous images. */
  readonly anomalyLabel: string;
  /** Extra CSV rows naming images that are not on disk. */
  readonly danglingRows?: readonly string[];
  /** Images on disk that the CSV does not mention. */
  readonly unlabeled?: readonly string[];
}

/**
 * Builds a synthetic VisA tree.
 *
 * @returns the root directory (the one that holds the `VisA` directory).
 */
function buildVisaTree(specs: readonly PartSpec[]): string {
  const root = makeTempDir('mv-visa-tree-');
  for (const spec of specs) {
    const partDir = path.join(root, 'VisA', spec.part);
    const csvRows: string[] = ['image,label,mask'];

    for (let index = 0; index < spec.normals; index += 1) {
      const name = `${String(index).padStart(4, '0')}.JPG`;
      writeImage(path.join(partDir, 'Data', 'Images', 'Normal', name));
      csvRows.push(`${spec.part}/Data/Images/Normal/${name},normal,`);
    }

    for (let index = 0; index < spec.anomalies; index += 1) {
      const name = `${String(index).padStart(3, '0')}.JPG`;
      writeImage(path.join(partDir, 'Data', 'Images', 'Anomaly', name));
      csvRows.push(
        `${spec.part}/Data/Images/Anomaly/${name},${spec.anomalyLabel},${spec.part}/Data/Masks/Anomaly/${name.replace('.JPG', '.png')}`,
      );
    }

    for (const row of spec.danglingRows ?? []) {
      csvRows.push(row);
    }

    mkdirSync(partDir, { recursive: true });
    writeFileSync(path.join(partDir, 'image_anno.csv'), `${csvRows.join('\n')}\n`, 'utf8');

    for (const name of spec.unlabeled ?? []) {
      writeImage(path.join(partDir, 'Data', 'Images', 'Normal', name));
    }
  }
  return root;
}

/** Opens a migrated store on a temporary path. */
async function openTempStore(): Promise<{
  db: ReturnType<typeof openMigratedStore> extends Promise<infer T> ? T : never;
  cleanup: () => void;
}> {
  const dir = makeTempDir('mv-visa-db-');
  const store = await openMigratedStore(path.join(dir, 'store.db'));
  return {
    db: store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('VisA annotation CSV', () => {
  it('parses the image, label and mask columns', () => {
    const rows = parseVisaAnnotationCsv(
      'image,label,mask\ncandle/Data/Images/Normal/0000.JPG,normal,\n' +
        'candle/Data/Images/Anomaly/000.JPG,chunk of wax missing,candle/Data/Masks/Anomaly/000.png\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      image: 'candle/Data/Images/Normal/0000.JPG',
      label: 'normal',
      mask: null,
    });
    expect(rows[1]?.mask).toBe('candle/Data/Masks/Anomaly/000.png');
  });

  it('keeps a quoted label that contains commas as ONE label', () => {
    const rows = parseVisaAnnotationCsv(
      'image,label,mask\n' +
        'candle/Data/Images/Anomaly/005.JPG,"chunk of wax missing,foreign particals on candle",\n',
    );
    expect(rows[0]?.label).toBe('chunk of wax missing,foreign particals on candle');
  });

  it('fails loudly when the header has no image/label columns', () => {
    expect(() => parseVisaAnnotationCsv('foo,bar\n1,2\n')).toThrow(/image.*label/);
  });
});

describe('the VisA label mapping', () => {
  it('maps a normal label to the normal key', () => {
    expect(mapVisaLabel('candle', 'normal').key).toBe(NORMAL_LABEL_KEY);
  });

  it('maps a taxonomy label to defect:<type>', () => {
    const mapped = mapVisaLabel('candle', 'chunk of wax missing');
    expect(mapped.key).toBe(`${DEFECT_LABEL_PREFIX}chunk-of-wax-missing`);
    expect(mapped.canonical).toBe('Chunk Of Wax Missing');
    expect(mapped.unmapped).toBe(false);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(mapVisaLabel('candle', 'Chunk  Of   Wax Missing').key).toBe(
      `${DEFECT_LABEL_PREFIX}chunk-of-wax-missing`,
    );
  });

  it('PRESERVES a label outside the taxonomy instead of dropping it', () => {
    const mapped = mapVisaLabel('candle', 'a brand new defect nobody catalogued');
    expect(mapped.unmapped).toBe(true);
    expect(mapped.canonical).toBeNull();
    expect(mapped.key).toBe(`${DEFECT_LABEL_PREFIX}a-brand-new-defect-nobody-catalogued`);
    expect(mapped.raw).toBe('a brand new defect nobody catalogued');
  });

  it('keys a multi-defect label by its first defect and preserves the whole label', () => {
    const mapped = mapVisaLabel('candle', 'chunk of wax missing,foreign particals on candle');
    expect(mapped.key).toBe(`${DEFECT_LABEL_PREFIX}chunk-of-wax-missing`);
    expect(mapped.raw).toBe('chunk of wax missing,foreign particals on candle');
  });

  it('never produces an empty key for an empty label', () => {
    const mapped = mapVisaLabel('candle', '   ');
    expect(mapped.key).toBe(`${DEFECT_LABEL_PREFIX}unlabeled`);
    expect(mapped.unmapped).toBe(true);
  });
});

describe('normalising a VisA subset into the 002 store', () => {
  it('writes a capture session, an asset and a sample per image', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 6, anomalies: 2, anomalyLabel: 'chunk of wax missing' },
      { part: 'capsules', normals: 4, anomalies: 1, anomalyLabel: 'bubble' },
    ]);
    const store = await openTempStore();
    try {
      const report = await normalizeVisaSubset({
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        targetImages: 100,
        dataset: {
          id: 'visa-subset',
          version: '20220922',
          license: 'CC BY 4.0',
          attribution: 'Zou et al., 2022.',
        },
      });

      expect(report.parts).toEqual(['candle', 'capsules']);
      expect(report.normalizedSamples).toHaveLength(13); // 8 normal + 4 anomalous + 1
      expect(report.countsByPart).toEqual({ candle: 8, capsules: 5 });
      expect(report.countsByKey[NORMAL_LABEL_KEY]).toBe(10);
      expect(report.countsByKey[`${DEFECT_LABEL_PREFIX}chunk-of-wax-missing`]).toBe(2);
      expect(report.countsByKey[`${DEFECT_LABEL_PREFIX}bubble`]).toBe(1);

      // The store really holds the rows.
      const sessions = store.db.db
        .prepare('SELECT id, source FROM capture_sessions ORDER BY source')
        .all() as { id: string; source: string }[];
      expect(sessions).toHaveLength(2);
      expect(sessions.map((row) => row.source)).toEqual(['visa/candle', 'visa/capsules']);

      const assets = store.db.db.prepare('SELECT COUNT(*) AS n FROM assets').get();
      expect(assets).toEqual({ n: 13 });

      const samples = store.db.db.prepare('SELECT COUNT(*) AS n FROM samples').get();
      expect(samples).toEqual({ n: 13 });

      const ontology = store.db.db
        .prepare('SELECT version, fingerprint FROM ontology_versions')
        .get() as { version: string; fingerprint: string };
      expect(ontology.version).toBe('visa-subset-20220922');
      expect(ontology.fingerprint).toBe(report.ontologyFingerprint);
      expect(ontology.fingerprint).toMatch(/^fp2:[0-9a-f]{16}$/);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('links every sample to its capture session and its ontology key', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 3, anomalies: 1, anomalyLabel: 'chunk of wax missing' },
    ]);
    const store = await openTempStore();
    try {
      const report = await normalizeVisaSubset({
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        targetImages: 100,
      });
      const rows = store.db.db
        .prepare(
          `SELECT a.path, a.capture_session_id, ann.label_key, ann.ontology_version_id
             FROM assets a
             JOIN samples s ON s.asset_id = a.id
             JOIN annotations ann ON ann.sample_id = s.id`,
        )
        .all() as { path: string; capture_session_id: string; label_key: string; ontology_version_id: string }[];

      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.capture_session_id).toBeTruthy();
        expect(row.ontology_version_id).toBe(report.ontologyVersionId);
      }
      const labels = rows.map((row) => row.label_key).sort();
      expect(labels).toEqual(
        [
          NORMAL_LABEL_KEY,
          NORMAL_LABEL_KEY,
          NORMAL_LABEL_KEY,
          `${DEFECT_LABEL_PREFIX}chunk-of-wax-missing`,
        ].sort(),
      );
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps every anomalous image and thins the normal ones to the target', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 40, anomalies: 10, anomalyLabel: 'chunk of wax missing' },
      { part: 'capsules', normals: 40, anomalies: 10, anomalyLabel: 'bubble' },
    ]);
    const store = await openTempStore();
    try {
      const report = await normalizeVisaSubset({
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        targetImages: 40,
      });
      // 20 anomalies are always kept; the rest is split evenly over the two parts.
      expect(report.normalizedSamples).toHaveLength(40);
      expect(report.countsByPart['candle']).toBe(20);
      expect(report.countsByPart['capsules']).toBe(20);
      expect(report.countsByKey[NORMAL_LABEL_KEY]).toBe(20);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spreads the thinned normal images over the whole capture range', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 40, anomalies: 0, anomalyLabel: 'chunk of wax missing' },
    ]);
    const store = await openTempStore();
    try {
      const report = await normalizeVisaSubset({
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        targetImages: 10,
      });
      const frames = report.normalizedSamples
        .map((sample) => sample.path)
        .map((file) => path.basename(file))
        .sort();
      // The first and the last normal image are both sampled: a prefix would
      // have taken only the head of the capture session.
      expect(frames).toContain('0000.JPG');
      expect(frames).toContain('0039.JPG');
      expect(frames.length).toBe(10);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT duplicate rows when it runs twice', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 5, anomalies: 2, anomalyLabel: 'chunk of wax missing' },
    ]);
    const store = await openTempStore();
    try {
      const options = {
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        targetImages: 100,
        dataset: {
          id: 'visa-subset',
          version: '20220922',
          license: 'CC BY 4.0',
          attribution: 'Zou et al., 2022.',
        },
      };
      const first = await normalizeVisaSubset(options);
      const second = await normalizeVisaSubset(options);

      expect(second.normalizedSamples).toHaveLength(first.normalizedSamples.length);
      expect(second.ontologyVersionId).toBe(first.ontologyVersionId);
      // Nothing new was written the second time.
      expect(second.assets).toBe(0);
      expect(second.samples).toBe(0);
      expect(second.annotations).toBe(0);

      const count = (table: string): number =>
        (store.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('assets')).toBe(7);
      expect(count('samples')).toBe(7);
      expect(count('annotations')).toBe(7);
      expect(count('capture_sessions')).toBe(1);
      expect(count('ontology_versions')).toBe(1);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an image that is on disk but absent from the CSV', async () => {
    const root = buildVisaTree([
      {
        part: 'candle',
        normals: 3,
        anomalies: 1,
        anomalyLabel: 'chunk of wax missing',
        unlabeled: ['9999.JPG'],
      },
    ]);
    const store = await openTempStore();
    try {
      const report = await normalizeVisaSubset({
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        targetImages: 100,
      });
      expect(report.unlabeledImages).toContain('candle/Data/Images/Normal/9999.JPG');
      // The unlabeled normal image is still normalised (the dataset's own
      // directory says it is normal), so it is counted.
      expect(report.countsByKey[NORMAL_LABEL_KEY]).toBe(4);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an annotation row that names an image which does not exist', async () => {
    const root = buildVisaTree([
      {
        part: 'candle',
        normals: 2,
        anomalies: 1,
        anomalyLabel: 'chunk of wax missing',
        danglingRows: ['candle/Data/Images/Anomaly/999.JPG,chunk of wax missing,'],
      },
    ]);
    const store = await openTempStore();
    try {
      const report = await normalizeVisaSubset({
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        targetImages: 100,
      });
      expect(report.danglingAnnotations).toContain('candle/Data/Images/Anomaly/999.JPG');
      // The dangling row does not become a sample.
      expect(report.normalizedSamples).toHaveLength(3);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PRESERVES a defect label outside the taxonomy in the ontology and the report', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 1, anomalies: 1, anomalyLabel: 'a defect nobody catalogued' },
    ]);
    const store = await openTempStore();
    try {
      const report = await normalizeVisaSubset({
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        targetImages: 100,
      });

      // The label survives: it has its own key, its own category and its raw
      // text in the report.
      const key = `${DEFECT_LABEL_PREFIX}a-defect-nobody-catalogued`;
      expect(report.countsByKey[key]).toBe(1);
      expect(report.unmappedLabels).toEqual([{ raw: 'a defect nobody catalogued', key }]);
      expect(report.normalizedSamples[0]?.rawLabel).toBe('a defect nobody catalogued');

      const categories = store.db.db
        .prepare('SELECT categories_json FROM ontology_versions')
        .get() as { categories_json: string };
      const parsed = JSON.parse(categories.categories_json) as {
        key: string;
        description: string;
      }[];
      const category = parsed.find((entry) => entry.key === key);
      expect(category).toBeDefined();
      expect(category?.description).toContain('a defect nobody catalogued');
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loudly when a part has no annotation CSV', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 2, anomalies: 1, anomalyLabel: 'chunk of wax missing' },
    ]);
    const store = await openTempStore();
    try {
      rmSync(path.join(root, 'VisA', 'candle', 'image_anno.csv'));
      await expect(
        normalizeVisaSubset({
          db: store.db.db,
          visaRoot: path.join(root, 'VisA'),
          targetImages: 100,
        }),
      ).rejects.toThrow(/image_anno/);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loudly when the selected object class is not in the tree', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 2, anomalies: 1, anomalyLabel: 'chunk of wax missing' },
    ]);
    const store = await openTempStore();
    try {
      await expect(
        normalizeVisaSubset({
          db: store.db.db,
          visaRoot: path.join(root, 'VisA'),
          parts: ['not-a-class'],
          targetImages: 100,
        }),
      ).rejects.toThrow(/not present/);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalises only the selected object classes', async () => {
    const root = buildVisaTree([
      { part: 'candle', normals: 3, anomalies: 1, anomalyLabel: 'chunk of wax missing' },
      { part: 'capsules', normals: 3, anomalies: 1, anomalyLabel: 'bubble' },
    ]);
    const store = await openTempStore();
    try {
      const report = await normalizeVisaSubset({
        db: store.db.db,
        visaRoot: path.join(root, 'VisA'),
        parts: ['candle'],
        targetImages: 100,
      });
      expect(report.parts).toEqual(['candle']);
      expect(report.countsByPart).toEqual({ candle: 4 });
      const sessions = store.db.db.prepare('SELECT source FROM capture_sessions').all();
      expect(sessions).toEqual([{ source: 'visa/candle' }]);
    } finally {
      store.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
