import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EntityIdSchema } from '@vision-lens/contracts';
import { describe, expect, it } from 'vitest';
import {
  LegacyImportError,
  defaultLegacyRoots,
  detectLegacyRunShape,
  importLegacyRun,
  legacyLabelKey,
  legacyRunManifestId,
  pathHashPlaceholderId,
  planLegacyRunImport,
} from '../../../src/store/index.js';
import { createTestStore, makeTempDir, removeTempDir } from '../helpers.js';

/**
 * The legacy-run importer (spec 002, US2 / task 4, SC-002).
 *
 * The fixtures under `tests/fixtures/legacy/` are SYNTHETIC on purpose: the
 * real `output/analysis_results.json` of this repository contains real file
 * names and real descriptions, and the repository is public. The synthetic
 * fixtures reproduce every edge the survey of the real file found:
 *
 *  - no `schemaVersion`, no `categoriesHash`, no `confidence`,
 *    no `extractedText`, no `fullDescription`;
 *  - a FLOAT `timestamp` (1753510199165.367);
 *  - a free-text `condition` value;
 *  - a record whose `outputFile` does not exist;
 *  - `overrides[]` (one of them pointing at a file the run does not contain);
 *  - `sessions[]`;
 *  - a nested-`analysis` partial-cache variant;
 *  - the docs-only `results` / `processedFiles` variants.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'legacy');

/** A synthetic legacy workspace: a run file plus the input/output roots. */
interface Workspace {
  readonly dir: string;
  readonly runPath: string;
  readonly inputRoot: string;
  readonly outputRoot: string;
  readonly cleanup: () => void;
}

/** Creates a workspace holding a copy of a fixture. */
function makeWorkspace(
  fixture: string,
  inputFiles: readonly string[] = [],
  outputFiles: readonly string[] = [],
): Workspace {
  const dir = makeTempDir('mv-import-');
  const runDir = path.join(dir, 'run');
  const inputRoot = path.join(dir, 'input');
  const outputRoot = path.join(dir, 'output');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(inputRoot, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });

  const runPath = path.join(runDir, fixture);
  writeFileSync(runPath, readFileSync(path.join(FIXTURES, fixture)));

  for (const name of inputFiles) {
    writeFileSync(path.join(inputRoot, name), `synthetic bytes for ${name}`);
  }
  for (const name of outputFiles) {
    writeFileSync(path.join(outputRoot, name), `synthetic exported bytes for ${name}`);
  }

  return {
    dir,
    runPath,
    inputRoot,
    outputRoot,
    cleanup: () => removeTempDir(dir),
  };
}

/** The row count of every table the importer touches. */
function tableCounts(db: {
  prepare: (sql: string) => { get: () => unknown };
}): Record<string, number> {
  const tables = [
    'assets',
    'samples',
    'predictions',
    'annotations',
    'capture_sessions',
    'ontology_versions',
    'model_versions',
    'experiment_runs',
    'legacy_imports',
    'legacy_sample_payloads',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    counts[table] = row.c;
  }
  return counts;
}

/** A recursive listing (relative path + size + mtime) of a directory. */
function snapshotDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(full, relative);
      } else {
        const stats = statSync(full);
        entries.push(`${relative}:${stats.size}:${stats.mtimeMs}`);
      }
    }
  };
  walk(dir, '');
  return entries;
}

describe('legacy run: shape detection', () => {
  it('detects the flat cache by its inline records', () => {
    const parsed = JSON.parse(readFileSync(path.join(FIXTURES, 'analysis_results.flat.json'), 'utf8'));
    expect(detectLegacyRunShape(parsed)).toBe('flat-cache');
  });

  it('detects the partial cache by its nested analysis', () => {
    const parsed = JSON.parse(
      readFileSync(path.join(FIXTURES, 'analysis_results.partial.json'), 'utf8'),
    );
    expect(detectLegacyRunShape(parsed)).toBe('partial-cache');
  });

  it('tolerates the docs-only results and processedFiles variants', () => {
    expect(
      detectLegacyRunShape(
        JSON.parse(readFileSync(path.join(FIXTURES, 'analysis_results.docs-results.json'), 'utf8')),
      ),
    ).toBe('docs-results');
    expect(
      detectLegacyRunShape(
        JSON.parse(
          readFileSync(path.join(FIXTURES, 'analysis_results.docs-processed-files.json'), 'utf8'),
        ),
      ),
    ).toBe('docs-processed-files');
  });

  it('refuses an unknown shape with an actionable message', () => {
    const parsed = JSON.parse(readFileSync(path.join(FIXTURES, 'unknown-shape.json'), 'utf8'));
    expect(() => detectLegacyRunShape(parsed)).toThrow(LegacyImportError);
    expect(() => detectLegacyRunShape(parsed)).toThrow(/Unrecognised legacy run shape/);
    expect(() => detectLegacyRunShape({ images: 'not-an-array' })).toThrow(/Unrecognised/);
  });
});

describe('legacy run: manifest id', () => {
  it('is the content hash: key order does not matter, content does', () => {
    const a = { processedDate: 'x', images: [{ category: 'kitchen', number: 1 }] };
    const b = { images: [{ number: 1, category: 'kitchen' }], processedDate: 'x' };
    expect(legacyRunManifestId(a)).toBe(legacyRunManifestId(b));
    expect(legacyRunManifestId(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(legacyRunManifestId(a)).not.toBe(
      legacyRunManifestId({ processedDate: 'x', images: [{ category: 'bathroom', number: 1 }] }),
    );
  });

  it('does NOT use processedDate as the identity', () => {
    const first = { processedDate: '2026-01-01T00:00:00.000Z', images: [{ category: 'a' }] };
    const second = { processedDate: '2026-01-01T00:00:00.000Z', images: [{ category: 'b' }] };
    expect(legacyRunManifestId(first)).not.toBe(legacyRunManifestId(second));
  });
});

describe('legacy run: golden import', () => {
  it('maps the synthetic flat run onto the exact expected rows', async () => {
    const workspace = makeWorkspace(
      'analysis_results.flat.json',
      ['SYNTHETIC-001.jpg', 'SYNTHETIC-003.jpg'],
      [],
    );
    const store = await createTestStore();
    try {
      const result = await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });

      // The mapping counts — the same numbers the CLI prints.
      expect(result.counts).toEqual({
        assets: 4,
        assetsHashed: 2,
        assetsUnhashed: 2,
        samples: 4,
        predictions: 4,
        annotations: 1,
        captureSessions: 2,
        ontologyVersions: 1,
        modelVersions: 1,
        experimentRuns: 1,
        legacyCarryOvers: 4,
        legacyConditions: 4,
        skippedRecords: 0,
        unmatchedOverrides: 1,
      });
      expect(result.alreadyImported).toBe(false);
      expect(result.wrote).toBe(true);
      expect(result.shape).toBe('flat-cache');

      // The exact row count of every table.
      expect(tableCounts(store.db)).toEqual({
        assets: 4,
        samples: 4,
        predictions: 4,
        annotations: 1,
        capture_sessions: 2,
        ontology_versions: 1,
        model_versions: 1,
        experiment_runs: 1,
        legacy_imports: 1,
        legacy_sample_payloads: 4,
      });
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('maps the labels, the ontology and the provenance the way the contracts demand', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json', ['SYNTHETIC-001.jpg']);
    const store = await createTestStore();
    try {
      await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });

      const predictions = store.db
        .prepare('SELECT * FROM predictions ORDER BY created_at, id')
        .all() as Record<string, unknown>[];
      expect(predictions).toHaveLength(4);
      // No confidence in the legacy file → 0, never 1.
      expect(predictions.every((row) => row['probability_raw'] === 0)).toBe(true);
      // Never a fabricated calibrated probability, latency or cost.
      expect(predictions.every((row) => row['probability_calibrated'] === null)).toBe(true);
      expect(predictions.every((row) => row['latency_ms'] === null)).toBe(true);
      expect(predictions.every((row) => row['cost_micro_usd'] === null)).toBe(true);
      // The actor is a MODEL (constitution II).
      expect(predictions.every((row) => row['actor_kind'] === 'model')).toBe(true);
      expect(String(predictions[0]!['actor_ref'])).toMatch(/^model:/);

      // The ontology: names only, so the descriptions are EMPTY (never invented).
      const ontology = store.db.prepare('SELECT * FROM ontology_versions').get() as Record<
        string,
        unknown
      >;
      const categories = JSON.parse(ontology['categories_json'] as string) as {
        key: string;
        name: string;
        description: string;
      }[];
      expect(categories).toEqual([
        { key: 'kitchen', name: 'kitchen', description: '' },
        { key: 'living_room', name: 'living_room', description: '' },
        { key: 'bathroom', name: 'bathroom', description: '' },
      ]);
      expect(String(ontology['fingerprint'])).toMatch(/^fp2:[0-9a-f]{16}$/);

      // The run itself.
      const run = store.db.prepare('SELECT * FROM experiment_runs').get() as Record<string, unknown>;
      expect(run['kind']).toBe('classify');
      expect(run['status']).toBe('succeeded');
      expect(String(run['config_fingerprint'])).toMatch(/^fp2:[0-9a-f]{16}$/);

      // The model version is a LEGACY PLACEHOLDER, not an invented model.
      const model = store.db.prepare('SELECT * FROM model_versions').get() as Record<string, unknown>;
      expect(model['registry_state']).toBe('legacy');
      expect(model['name']).toBe('legacy-unknown');

      // The human override is an ANNOTATION with a human actor.
      const annotation = store.db.prepare('SELECT * FROM annotations').get() as Record<
        string,
        unknown
      >;
      expect(annotation['actor_kind']).toBe('human');
      expect(annotation['surface']).toBe('cli');
      expect(annotation['label_key']).toBe('living_room');
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('truncates the float timestamp of the legacy record', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json');
    const store = await createTestStore();
    try {
      await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      const created = store.db
        .prepare('SELECT created_at FROM predictions ORDER BY created_at')
        .all() as { created_at: string }[];
      // The float record (1753510199165.367) is truncated to whole millis.
      const truncated = created.find((row) => row.created_at.endsWith('.165Z'));
      expect(truncated?.created_at).toBe('2025-07-26T06:09:59.165Z');
      expect(Date.parse(truncated!.created_at)).toBe(1753510199165);
      // No sub-millisecond digits survive the truncation.
      expect(created.every((row) => /\.\d{3}Z$/.test(row.created_at))).toBe(true);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('preserves the legacy condition verbatim in the carry-over', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json');
    const store = await createTestStore();
    try {
      await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      const payloads = store.db
        .prepare('SELECT condition_text, payload_json FROM legacy_sample_payloads')
        .all() as { condition_text: string | null; payload_json: string }[];

      const conditions = payloads.map((row) => row.condition_text).sort();
      expect(conditions).toEqual(['damaged', 'good', 'peeling paint', 'transaction recorded']);

      // The whole legacy record is preserved verbatim.
      const withCondition = payloads.find((row) => row.condition_text === 'peeling paint');
      const payload = JSON.parse(withCondition!.payload_json) as Record<string, unknown>;
      expect(payload['condition']).toBe('peeling paint');
      expect(payload['shortDescription']).toBe('synthetic kitchen with a sink');
      expect(payload['elements']).toEqual(['sink', 'tiles']);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });
});

describe('legacy run: idempotency', () => {
  it('imports the same run twice without writing a single extra row', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json', ['SYNTHETIC-001.jpg']);
    const store = await createTestStore();
    try {
      const storeHandle = { path: store.dbPath, db: store.db, close: () => undefined };
      const first = await importLegacyRun({
        runPath: workspace.runPath,
        store: storeHandle,
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      const before = tableCounts(store.db);

      const second = await importLegacyRun({
        runPath: workspace.runPath,
        store: storeHandle,
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      const after = tableCounts(store.db);

      expect(first.wrote).toBe(true);
      expect(second.wrote).toBe(false);
      expect(second.alreadyImported).toBe(true);
      expect(second.manifestId).toBe(first.manifestId);
      expect(second.counts).toEqual(first.counts);
      expect(after).toEqual(before);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('maps a re-serialized run (different key order) onto the same manifest id', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json');
    const store = await createTestStore();
    try {
      const storeHandle = { path: store.dbPath, db: store.db, close: () => undefined };
      const first = await importLegacyRun({
        runPath: workspace.runPath,
        store: storeHandle,
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });

      // Same content, keys in a different order.
      const parsed = JSON.parse(readFileSync(workspace.runPath, 'utf8')) as Record<string, unknown>;
      const reordered = Object.fromEntries(Object.entries(parsed).reverse()) as Record<
        string,
        unknown
      >;
      writeFileSync(workspace.runPath, JSON.stringify(reordered));

      const second = await importLegacyRun({
        runPath: workspace.runPath,
        store: storeHandle,
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });

      expect(second.manifestId).toBe(first.manifestId);
      expect(second.alreadyImported).toBe(true);
      expect(tableCounts(store.db)['legacy_imports']).toBe(1);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });
});

describe('legacy run: bytes', () => {
  it('flags an unreachable asset as unhashed with the deterministic placeholder id', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json');
    const store = await createTestStore();
    try {
      await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });

      const assets = store.db.prepare('SELECT * FROM assets').all() as Record<string, unknown>[];
      expect(assets).toHaveLength(4);
      expect(assets.every((row) => row['unhashed'] === 1)).toBe(true);
      expect(assets.every((row) => row['sha256'] === null)).toBe(true);
      // The placeholder id is the path hash (store/ids.ts), not a fresh uuid.
      for (const row of assets) {
        expect(row['id']).toBe(pathHashPlaceholderId(String(row['path'])));
        expect(EntityIdSchema.safeParse(row['id']).success).toBe(true);
      }
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('hashes the bytes when they are reachable', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json', ['SYNTHETIC-001.jpg']);
    const store = await createTestStore();
    try {
      await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });

      const hashed = store.db
        .prepare('SELECT * FROM assets WHERE unhashed = 0')
        .get() as Record<string, unknown>;
      expect(hashed).toBeDefined();
      const expected = createHash('sha256')
        .update(readFileSync(path.join(workspace.inputRoot, 'SYNTHETIC-001.jpg')))
        .digest('hex');
      expect(hashed['sha256']).toBe(expected);
      expect(hashed['unhashed']).toBe(0);
      // The identity is a uuidv7; the content address is the sha256 column.
      expect(EntityIdSchema.safeParse(hashed['id']).success).toBe(true);
      expect(hashed['id']).not.toBe(expected);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('falls back to the exported image when the original is gone', async () => {
    const workspace = makeWorkspace(
      'analysis_results.flat.json',
      [],
      ['001. Synthetic photo dated 01-01-2026.jpeg'],
    );
    try {
      const plan = planLegacyRunImport({
        runPath: workspace.runPath,
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      const first = plan.assets[0]!;
      expect(first.unhashed).toBe(false);
      expect(first.path).toBe(
        path.join(workspace.outputRoot, '001. Synthetic photo dated 01-01-2026.jpeg'),
      );
    } finally {
      workspace.cleanup();
    }
  });
});

describe('legacy run: the originals are never mutated', () => {
  it('leaves the run file and the image bytes untouched, and writes nothing next to them', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json', ['SYNTHETIC-001.jpg']);
    const store = await createTestStore();
    try {
      const runBefore = readFileSync(workspace.runPath);
      const runStatsBefore = statSync(workspace.runPath);
      const imageBefore = readFileSync(path.join(workspace.inputRoot, 'SYNTHETIC-001.jpg'));
      const dirBefore = snapshotDir(path.dirname(workspace.runPath));
      const inputBefore = snapshotDir(workspace.inputRoot);
      const outputBefore = snapshotDir(workspace.outputRoot);

      await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });

      expect(readFileSync(workspace.runPath).equals(runBefore)).toBe(true);
      expect(statSync(workspace.runPath).mtimeMs).toBe(runStatsBefore.mtimeMs);
      expect(statSync(workspace.runPath).size).toBe(runStatsBefore.size);
      expect(
        readFileSync(path.join(workspace.inputRoot, 'SYNTHETIC-001.jpg')).equals(imageBefore),
      ).toBe(true);
      expect(snapshotDir(path.dirname(workspace.runPath))).toEqual(dirBefore);
      expect(snapshotDir(workspace.inputRoot)).toEqual(inputBefore);
      expect(snapshotDir(workspace.outputRoot)).toEqual(outputBefore);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });
});

describe('legacy run: shape tolerance', () => {
  it('imports the nested-analysis partial cache', async () => {
    const workspace = makeWorkspace('analysis_results.partial.json', ['SYNTHETIC-101.jpg']);
    const store = await createTestStore();
    try {
      const result = await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      expect(result.shape).toBe('partial-cache');
      expect(result.counts.assets).toBe(2);
      expect(result.counts.predictions).toBe(2);
      expect(result.counts.annotations).toBe(0);
      expect(result.counts.captureSessions).toBe(0);

      // The taxonomy is reconstructed from the labels the run produced.
      const ontology = store.db.prepare('SELECT * FROM ontology_versions').get() as Record<
        string,
        unknown
      >;
      const categories = JSON.parse(ontology['categories_json'] as string) as {
        key: string;
        description: string;
      }[];
      expect(categories.map((category) => category.key)).toEqual(['kitchen', 'bathroom']);
      expect(categories.every((category) => category.description === '')).toBe(true);

      // The confidence of the partial cache IS carried over.
      const probabilities = (
        store.db.prepare('SELECT probability_raw FROM predictions').all() as {
          probability_raw: number;
        }[]
      ).map((row) => row.probability_raw);
      expect(probabilities.sort()).toEqual([0.42, 0.9]);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('tolerates the docs-only results variant', async () => {
    const workspace = makeWorkspace('analysis_results.docs-results.json', ['SYNTHETIC-201.jpg']);
    const store = await createTestStore();
    try {
      const result = await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      expect(result.shape).toBe('docs-results');
      expect(result.counts.assets).toBe(1);
      expect(result.counts.predictions).toBe(1);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('tolerates the docs-only processedFiles variant', async () => {
    const workspace = makeWorkspace('analysis_results.docs-processed-files.json');
    const store = await createTestStore();
    try {
      const result = await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      expect(result.shape).toBe('docs-processed-files');
      expect(result.counts.assets).toBe(2);
      expect(result.counts.predictions).toBe(0);
      expect(result.counts.ontologyVersions).toBe(0);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });

  it('fails with a clear message on a missing file, invalid JSON and an unknown shape', async () => {
    const store = await createTestStore();
    const workspace = makeWorkspace('analysis_results.flat.json');
    try {
      await expect(
        importLegacyRun({
          runPath: path.join(workspace.dir, 'does-not-exist.json'),
          store: { path: store.dbPath, db: store.db, close: () => undefined },
        }),
      ).rejects.toThrow(/not found/);

      await expect(
        importLegacyRun({
          runPath: path.join(FIXTURES, 'invalid.json'),
          store: { path: store.dbPath, db: store.db, close: () => undefined },
        }),
      ).rejects.toThrow(/not valid JSON/);

      await expect(
        importLegacyRun({
          runPath: path.join(FIXTURES, 'unknown-shape.json'),
          store: { path: store.dbPath, db: store.db, close: () => undefined },
        }),
      ).rejects.toThrow(/Unrecognised legacy run shape/);

      // A failed import writes nothing.
      expect(tableCounts(store.db)['assets']).toBe(0);
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });
});

describe('legacy run: transactional', () => {
  it('writes NOTHING when one record of the run is invalid', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json');
    const store = await createTestStore();
    try {
      // A confidence outside 0..1 is refused: it is not clamped, because a
      // fabricated probability would be worse than a failed import.
      const parsed = JSON.parse(readFileSync(workspace.runPath, 'utf8')) as {
        images: Record<string, unknown>[];
      };
      parsed.images[0]!['confidence'] = 4.2;
      writeFileSync(workspace.runPath, JSON.stringify(parsed));

      await expect(
        importLegacyRun({
          runPath: workspace.runPath,
          store: { path: store.dbPath, db: store.db, close: () => undefined },
          inputRoot: workspace.inputRoot,
          outputRoot: workspace.outputRoot,
        }),
      ).rejects.toThrow(/outside 0\.\.1/);

      const counts = tableCounts(store.db);
      for (const [table, count] of Object.entries(counts)) {
        expect(`${table}=${count}`).toBe(`${table}=0`);
      }
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });
});

describe('legacy run: untrusted content', () => {
  it('never follows a path out of the roots it was given', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json');
    try {
      const parsed = JSON.parse(readFileSync(workspace.runPath, 'utf8')) as {
        images: Record<string, unknown>[];
      };
      // A hand-edited record that points outside the input root.
      parsed.images[0]!['originalFile'] = '../../../../etc/passwd';
      writeFileSync(workspace.runPath, JSON.stringify(parsed));

      const plan = planLegacyRunImport({
        runPath: workspace.runPath,
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });
      const resolved = plan.assets[0]!;
      expect(resolved.path.startsWith(path.resolve(workspace.inputRoot) + path.sep)).toBe(true);
      expect(resolved.path).toBe(path.join(workspace.inputRoot, 'passwd'));
      expect(resolved.unhashed).toBe(true);
    } finally {
      workspace.cleanup();
    }
  });

  it('never executes the content of the run file', async () => {
    const workspace = makeWorkspace('analysis_results.flat.json');
    const store = await createTestStore();
    try {
      const parsed = JSON.parse(readFileSync(workspace.runPath, 'utf8')) as {
        images: Record<string, unknown>[];
      };
      parsed.images[0]!['shortDescription'] = '$(rm -rf /) `node -e "process.exit(1)"`';
      writeFileSync(workspace.runPath, JSON.stringify(parsed));

      await importLegacyRun({
        runPath: workspace.runPath,
        store: { path: store.dbPath, db: store.db, close: () => undefined },
        inputRoot: workspace.inputRoot,
        outputRoot: workspace.outputRoot,
      });

      const payload = store.db
        .prepare('SELECT payload_json FROM legacy_sample_payloads LIMIT 1')
        .get() as { payload_json: string };
      // The content is stored as DATA, verbatim — never evaluated.
      expect(payload.payload_json).toContain('$(rm -rf /)');
    } finally {
      store.cleanup();
      workspace.cleanup();
    }
  });
});

describe('legacy run: roots and labels', () => {
  it('derives the roots from the run file location', () => {
    const roots = defaultLegacyRoots('/tmp/project/output/analysis_results.json');
    expect(roots.inputRoot).toBe(path.resolve('/tmp/project/input'));
    expect(roots.outputRoot).toBe(path.resolve('/tmp/project/output'));

    const flat = defaultLegacyRoots('/tmp/project/run/analysis_results.json');
    expect(flat.inputRoot).toBe(path.resolve('/tmp/project/run/input'));
    expect(flat.outputRoot).toBe(path.resolve('/tmp/project/run/output'));
  });

  it('derives the label key from the legacy category name', () => {
    expect(legacyLabelKey('living_room')).toBe('living_room');
    expect(legacyLabelKey('Photo of Kitchen')).toBe('photo_of_kitchen');
    expect(legacyLabelKey('  ')).toBe('unknown');
  });
});
