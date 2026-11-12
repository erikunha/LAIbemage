import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyMigrations,
  defaultMigrationsDir,
  openStore,
  readMigrations,
  rollbackMigrations,
  StoreMigrationError,
} from '../../src/store/index.js';
import { createTestStore, makeTempDir, removeTempDir } from './helpers.js';

/**
 * Migration protocol (spec 002, task 3.1, US2 scenario 1).
 *
 * Covers: fresh migration, hash recording, refusal on edited history,
 * rollback rehearsal and re-apply. Every test uses an explicit temporary
 * directory; the repository's own `.sql` files are never modified — the
 * tampered case works on a COPY.
 */
describe('store migrations', () => {
  it('migrates a fresh database to the latest version', async () => {
    const store = await createTestStore();
    try {
      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const names = tables.map((row) => row.name);

      // The 14 domain tables + the ledger.
      for (const expected of [
        'assets',
        'capture_sessions',
        'ontology_versions',
        'samples',
        'annotations',
        'predictions',
        'dataset_snapshots',
        'experiment_runs',
        'model_versions',
        'evaluation_runs',
        'deployments',
        'feedback_events',
        'agent_runs',
        'derived_artifacts',
        'schema_migrations',
        // The legacy-importer bookkeeping (migration 0002).
        'legacy_imports',
        'legacy_sample_payloads',
      ]) {
        expect(names).toContain(expected);
      }

      const views = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='view'")
        .all() as { name: string }[];
      expect(views.map((row) => row.name)).toContain('label_view');
    } finally {
      store.cleanup();
    }
  });

  it('records the sha256 of every applied migration', async () => {
    const store = await createTestStore();
    try {
      const rows = store.db
        .prepare('SELECT id, hash, applied_at FROM schema_migrations ORDER BY id')
        .all() as { id: string; hash: string; applied_at: string }[];

      expect(rows.length).toBe(3);
      expect(rows[0]!.id).toBe('0001');
      expect(rows[1]!.id).toBe('0002');
      expect(rows[2]!.id).toBe('0003');

      const definitions = readMigrations(defaultMigrationsDir());
      for (const row of rows) {
        const definition = definitions.find((candidate) => candidate.id === row.id);
        expect(definition).toBeDefined();
        expect(row.hash).toBe(definition!.hash);
        expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(Date.parse(row.applied_at)).not.toBeNaN();
      }
    } finally {
      store.cleanup();
    }
  });

  it('is idempotent: a second run applies nothing', async () => {
    const store = await createTestStore();
    try {
      const report = applyMigrations(store.db);
      expect(report.applied).toEqual([]);
      expect(report.alreadyApplied).toEqual(['0001', '0002', '0003']);
      expect(report.version).toBe('0003');
    } finally {
      store.cleanup();
    }
  });

  it('REFUSES to run when an applied migration was edited', async () => {
    const store = await createTestStore();
    const tamperedDir = makeTempDir('mv-store-migrations-');
    try {
      // Work on a COPY: the repository's SQL files are never touched.
      cpSync(defaultMigrationsDir(), tamperedDir, { recursive: true });
      const target = path.join(tamperedDir, '0001_init.sql');
      const original = readFileSync(target, 'utf8');
      writeFileSync(target, `${original}\n-- tampered\n`, 'utf8');

      let thrown: unknown;
      try {
        applyMigrations(store.db, { migrationsDir: tamperedDir });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreMigrationError);
      const message = (thrown as Error).message;
      expect(message).toContain('0001');
      expect(message).toContain('edited');
      // Both hashes are named so the operator can compare them.
      const hashes = message.match(/[0-9a-f]{64}/g) ?? [];
      expect(hashes.length).toBeGreaterThanOrEqual(2);
      expect(hashes[0]).not.toBe(hashes[1]);

      // The ledger is untouched: the tampered run applied nothing.
      const rows = store.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as {
        c: number;
      };
      expect(rows.c).toBe(3);
    } finally {
      store.cleanup();
      removeTempDir(tamperedDir);
    }
  });

  it('rolls back to the previous version and re-applies', async () => {
    const store = await createTestStore();
    try {
      const rollback = rollbackMigrations(store.db, '0000');
      // The rollback runs in DESCENDING id order (the newest first).
      expect(rollback.applied).toEqual(['0003', '0002', '0001']);

      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map((row) => row.name)).not.toContain('assets');
      expect(tables.map((row) => row.name)).not.toContain('legacy_imports');
      expect(tables.map((row) => row.name)).toContain('schema_migrations');

      const ledger = store.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as {
        c: number;
      };
      expect(ledger.c).toBe(0);

      // Re-apply works and the schema comes back.
      const reapply = applyMigrations(store.db);
      expect(reapply.applied).toEqual(['0001', '0002', '0003']);
      const restored = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'")
        .get();
      expect(restored).toBeDefined();
      const restoredLegacy = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_imports'")
        .get();
      expect(restoredLegacy).toBeDefined();

      // The rollback was real, not decorative: the integrity check passes.
      const integrity = store.db.pragma('integrity_check') as { integrity_check: string }[];
      expect(integrity[0]!.integrity_check).toBe('ok');
    } finally {
      store.cleanup();
    }
  });

  it('refuses to roll back when the rollback script is missing', async () => {
    const store = await createTestStore();
    const brokenDir = makeTempDir('mv-store-migrations-');
    try {
      cpSync(defaultMigrationsDir(), brokenDir, { recursive: true });
      const fs = await import('node:fs');
      fs.rmSync(path.join(brokenDir, '0001_init.rollback.sql'));

      expect(() => rollbackMigrations(store.db, '0000', { migrationsDir: brokenDir })).toThrow(
        /rollback script/,
      );
    } finally {
      store.cleanup();
      removeTempDir(brokenDir);
    }
  });

  it('reports a broken history when a recorded migration file vanished', async () => {
    const store = await createTestStore();
    const brokenDir = makeTempDir('mv-store-migrations-');
    try {
      cpSync(defaultMigrationsDir(), brokenDir, { recursive: true });
      const fs = await import('node:fs');
      fs.rmSync(path.join(brokenDir, '0001_init.sql'));

      expect(() => applyMigrations(store.db, { migrationsDir: brokenDir })).toThrow(
        /missing from/,
      );
    } finally {
      store.cleanup();
      removeTempDir(brokenDir);
    }
  });

  it('opens a store on a path whose parent directory does not exist yet', async () => {
    const dir = makeTempDir('mv-store-nested-');
    const nested = path.join(dir, 'a', 'b', 'store.db');
    const store = await openStore(nested);
    try {
      applyMigrations(store.db);
      expect(store.path).toBe(nested);
    } finally {
      store.close();
      removeTempDir(dir);
    }
  });

  it('refuses a history with a GAP: a never-applied migration whose file vanished', async () => {
    const storeDir = makeTempDir('mv-store-migrations-');
    const firstDir = makeTempDir('mv-store-migrations-');
    const gapDir = makeTempDir('mv-store-migrations-');
    const store = await openStore(path.join(storeDir, 'store.db'));
    try {
      // A directory that holds ONLY the first migration.
      cpSync(path.join(defaultMigrationsDir(), '0001_init.sql'), path.join(firstDir, '0001_init.sql'));
      cpSync(
        path.join(defaultMigrationsDir(), '0001_init.rollback.sql'),
        path.join(firstDir, '0001_init.rollback.sql'),
      );
      applyMigrations(store.db, { migrationsDir: firstDir });

      // The same directory, plus a migration '0003' — while '0002' is gone
      // from disk and was never applied. The old runner skipped it silently.
      cpSync(path.join(firstDir, '0001_init.sql'), path.join(gapDir, '0001_init.sql'));
      cpSync(
        path.join(firstDir, '0001_init.rollback.sql'),
        path.join(gapDir, '0001_init.rollback.sql'),
      );
      writeFileSync(
        path.join(gapDir, '0003_next.sql'),
        'CREATE TABLE gap_probe (id TEXT PRIMARY KEY);\n',
        'utf8',
      );

      let thrown: unknown;
      try {
        applyMigrations(store.db, { migrationsDir: gapDir });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreMigrationError);
      const message = (thrown as Error).message;
      expect(message).toContain('0002');
      expect(message).toMatch(/missing/i);
      // The store's own error, never a raw driver error.
      expect((thrown as { code?: string }).code).toBeUndefined();

      // Nothing was applied: the ledger is untouched and the probe table does
      // not exist.
      const ledger = store.db
        .prepare('SELECT id FROM schema_migrations ORDER BY id')
        .all() as { id: string }[];
      expect(ledger.map((row) => row.id)).toEqual(['0001']);
      const probe = store.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'gap_probe'")
        .get();
      expect(probe).toBeUndefined();
    } finally {
      store.close();
      removeTempDir(storeDir);
      removeTempDir(firstDir);
      removeTempDir(gapDir);
    }
  });

  it('refuses a history that is OUT OF ORDER: a lower migration appeared later', async () => {
    const storeDir = makeTempDir('mv-store-migrations-');
    const firstDir = makeTempDir('mv-store-migrations-');
    const lateDir = makeTempDir('mv-store-migrations-');
    const store = await openStore(path.join(storeDir, 'store.db'));
    try {
      cpSync(path.join(defaultMigrationsDir(), '0001_init.sql'), path.join(firstDir, '0001_init.sql'));
      cpSync(
        path.join(defaultMigrationsDir(), '0001_init.rollback.sql'),
        path.join(firstDir, '0001_init.rollback.sql'),
      );
      applyMigrations(store.db, { migrationsDir: firstDir });

      // A migration with a LOWER id shows up after '0001' was applied. The old
      // runner applied it and died with a raw `SqliteError`.
      cpSync(path.join(firstDir, '0001_init.sql'), path.join(lateDir, '0001_init.sql'));
      cpSync(
        path.join(firstDir, '0001_init.rollback.sql'),
        path.join(lateDir, '0001_init.rollback.sql'),
      );
      writeFileSync(
        path.join(lateDir, '0000_early.sql'),
        'CREATE TABLE early_probe (id TEXT PRIMARY KEY);\n',
        'utf8',
      );

      let thrown: unknown;
      try {
        applyMigrations(store.db, { migrationsDir: lateDir });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreMigrationError);
      const message = (thrown as Error).message;
      expect(message).toContain('0000');
      expect(message).toMatch(/out of order/i);
      expect((thrown as { code?: string }).code).toBeUndefined();

      // The late migration was NOT applied.
      const ledger = store.db
        .prepare('SELECT id FROM schema_migrations ORDER BY id')
        .all() as { id: string }[];
      expect(ledger.map((row) => row.id)).toEqual(['0001']);
      const probe = store.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'early_probe'")
        .get();
      expect(probe).toBeUndefined();
    } finally {
      store.close();
      removeTempDir(storeDir);
      removeTempDir(firstDir);
      removeTempDir(lateDir);
    }
  });
});
