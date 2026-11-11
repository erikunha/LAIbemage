import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyMigrations,
  defaultMigrationsDir,
  fromJsonColumn,
  isStoreConsistencyError,
  isStoreMigrationError,
  isStoreUnavailableError,
  isStoreValidationError,
  isStrictlyAfter,
  migrateStore,
  nextTimestamp,
  openMigratedStore,
  openStore,
  rollbackStore,
  StoreConsistencyError,
  StoreMigrationError,
  StoreUnavailableError,
  StoreValidationError,
  toJsonColumn,
  toRequiredJsonColumn,
} from '../../src/store/index.js';
import {
  agentRunFixture,
  annotationFixture,
  assetFixture,
  captureSessionFixture,
  createTestStore,
  deploymentFixture,
  makeTempDir,
  ontologyFixture,
  removeTempDir,
  sampleFixture,
  snapshotFixture,
} from './helpers.js';

/**
 * The public surface of the store: opening, migrating and the shared
 * helpers. These are the paths a caller (the importer of task 4, the CLI of
 * task 4.3, the later specs) actually uses.
 */
describe('store public surface', () => {
  it('opens a migrated store in one call', async () => {
    const dir = makeTempDir('mv-store-api-');
    try {
      const store = await openMigratedStore(path.join(dir, 'store.db'));
      try {
        const tables = store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'")
          .get();
        expect(tables).toBeDefined();
        // Closing twice must be safe.
        store.close();
        store.close();
      } finally {
        store.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  it('closes the store when the migration fails', async () => {
    const dir = makeTempDir('mv-store-api-');
    try {
      await expect(
        openMigratedStore(path.join(dir, 'store.db'), { migrationsDir: '/does/not/exist' }),
      ).rejects.toThrow(/migrations directory/);
    } finally {
      removeTempDir(dir);
    }
  });

  it('migrates and rolls back through the path-level helpers', async () => {
    const dir = makeTempDir('mv-store-api-');
    const dbPath = path.join(dir, 'store.db');
    try {
      const applied = await migrateStore(dbPath);
      expect(applied.applied).toEqual(['0001', '0002']);
      expect(applied.version).toBe('0002');

      const rolledBack = await rollbackStore(dbPath, '0000');
      // The rollback runs in DESCENDING id order (the newest first).
      expect(rolledBack.applied).toEqual(['0002', '0001']);
      expect(rolledBack.version).toBeNull();

      const reapplied = await migrateStore(dbPath);
      expect(reapplied.applied).toEqual(['0001', '0002']);
    } finally {
      removeTempDir(dir);
    }
  });

  it('honours the open options', async () => {
    const dir = makeTempDir('mv-store-api-');
    try {
      const store = await openStore(path.join(dir, 'store.db'), {
        busyTimeoutMs: 1234,
        synchronous: 'FULL',
      });
      try {
        expect(store.db.pragma('busy_timeout', { simple: true })).toBe(1234);
        expect(store.db.pragma('synchronous', { simple: true })).toBe(2); // FULL
        expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
        expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
      } finally {
        store.close();
      }

      // `createParentDir: false` refuses to invent a directory.
      await expect(
        openStore(path.join(dir, 'missing', 'store.db'), { createParentDir: false }),
      ).rejects.toThrow();
      expect(existsSync(path.join(dir, 'missing'))).toBe(false);
    } finally {
      removeTempDir(dir);
    }
  });

  it('serialises JSON columns canonically', () => {
    expect(toJsonColumn(undefined)).toBeNull();
    expect(toJsonColumn(null)).toBeNull();
    expect(toJsonColumn({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(fromJsonColumn<number[]>(null)).toBeUndefined();
    expect(fromJsonColumn<number[]>('[1,2]')).toEqual([1, 2]);
    expect(() => toRequiredJsonColumn(undefined, 'x_json')).toThrow(/must not be absent/);
    expect(toRequiredJsonColumn([1, 2], 'x_json')).toBe('[1,2]');
  });

  it('issues strictly increasing timestamps', () => {
    const first = nextTimestamp();
    const second = nextTimestamp();
    expect(isStrictlyAfter(second, first)).toBe(true);
    expect(isStrictlyAfter(first, second)).toBe(false);
    expect(isStrictlyAfter(first, first)).toBe(false);
  });

  it('classifies the store errors', async () => {
    const unavailable = new StoreUnavailableError('better-sqlite3 is not installed');
    const validation = new StoreValidationError('Invalid Annotation payload', []);
    const migration = new StoreMigrationError('The migration history is broken');
    const consistency = new StoreConsistencyError('The store is inconsistent');

    // The TRUE branch of every guard, with a real instance of that class…
    expect(isStoreUnavailableError(unavailable)).toBe(true);
    expect(isStoreValidationError(validation)).toBe(true);
    expect(isStoreMigrationError(migration)).toBe(true);
    expect(isStoreConsistencyError(consistency)).toBe(true);

    // …and the FALSE branch: another store error, and a foreign error.
    expect(isStoreUnavailableError(validation)).toBe(false);
    expect(isStoreValidationError(unavailable)).toBe(false);
    expect(isStoreMigrationError(validation)).toBe(false);
    expect(isStoreConsistencyError(migration)).toBe(false);
    expect(isStoreUnavailableError(new Error('nope'))).toBe(false);
    expect(isStoreValidationError(new Error('nope'))).toBe(false);
    expect(isStoreMigrationError(new Error('nope'))).toBe(false);
    expect(isStoreConsistencyError(new Error('nope'))).toBe(false);
  });

  it('exposes the list queries of every aggregate', async () => {
    const store = await createTestStore();
    try {
      const { repos } = store;

      const session = repos.captureSessions.insert(captureSessionFixture({ source: 'cam-1' }));
      expect(repos.captureSessions.getById(session.id)?.source).toBe('cam-1');
      expect(repos.captureSessions.listBySource('cam-1')).toHaveLength(1);
      expect(repos.captureSessions.listBySource('cam-2')).toHaveLength(0);

      const asset = repos.assets.insert(assetFixture({ path: '/tmp/found.jpg' }));
      expect(repos.assets.findByPath('/tmp/found.jpg')?.id).toBe(asset.id);
      expect(repos.assets.findByPath('/tmp/missing.jpg')).toBeUndefined();

      const ontology = repos.ontology.insert(ontologyFixture());
      const child = repos.ontology.insert(ontologyFixture({ parentId: ontology.id }));
      expect(repos.ontology.listLineage(ontology.id).map((entry) => entry.id)).toEqual([
        ontology.id,
        child.id,
      ]);

      const snapshot = repos.snapshots.insert(
        snapshotFixture({ ontologyVersionId: ontology.id, parentSnapshotId: undefined }),
      );
      const childSnapshot = repos.snapshots.insert(
        snapshotFixture({ ontologyVersionId: ontology.id, parentSnapshotId: snapshot.id }),
      );
      expect(repos.snapshots.listLineage(childSnapshot.id).map((entry) => entry.id)).toEqual([
        snapshot.id,
        childSnapshot.id,
      ]);

      const sample = repos.samples.insert(
        sampleFixture({ assetId: asset.id, snapshotIds: [snapshot.id] }),
      );
      expect(repos.samples.listBySnapshot(snapshot.id).map((entry) => entry.id)).toEqual([sample.id]);

      repos.annotations.insert(
        annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
      );
      expect(repos.annotations.latestForSample(sample.id)).toBeDefined();

      const model = repos.models.insert(
        { id: '01900000-0000-7000-8000-0000000000c1', name: 'm', version: 'v', registryState: 'draft', createdAt: '2024-01-01T00:00:00.000Z' },
      );
      const deployment = repos.deployments.insert(
        deploymentFixture({ modelVersionId: model.id, target: 'prod' }),
      );
      expect(repos.deployments.findActive('prod')).toBeUndefined();
      repos.deployments.setActive(deployment.id, true);
      expect(repos.deployments.findActive('prod')?.id).toBe(deployment.id);
      expect(repos.deployments.findActive('staging')).toBeUndefined();

      const agentRun = repos.agentRuns.insert(agentRunFixture());
      expect(repos.agentRuns.updateStatus(agentRun.id, 'succeeded').status).toBe('succeeded');
    } finally {
      store.cleanup();
    }
  });

  it('reads the migrations directory through the default resolver', () => {
    const dir = defaultMigrationsDir();
    expect(dir.endsWith('migrations')).toBe(true);
    expect(existsSync(path.join(dir, '0001_init.sql'))).toBe(true);
    expect(existsSync(path.join(dir, '0001_init.rollback.sql'))).toBe(true);
  });

  it('applies migrations to an already migrated database without changing the schema', async () => {
    const store = await createTestStore();
    try {
      const before = store.db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'")
        .get() as { c: number };
      applyMigrations(store.db);
      const after = store.db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'")
        .get() as { c: number };
      expect(after.c).toBe(before.c);
    } finally {
      store.cleanup();
    }
  });
});
