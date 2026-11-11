import { describe, expect, it } from 'vitest';
import {
  assetFixture,
  createTestStore,
  modelVersionFixture,
  ontologyFixture,
  sampleFixture,
} from './helpers.js';

/**
 * The database-level invariants of the provenance columns (constitution II).
 *
 * "Provenance is mandatory" is a STRUCTURAL claim, not a convention: the
 * columns that carry a value the store can name — `actor_ref` and `surface` —
 * are CHECK-constrained against the empty string. A raw INSERT that bypasses
 * the repository entirely (a migration script, a maintenance command, a
 * future importer) is refused by SQLite itself.
 *
 * The sentinel column (`session_id`) is deliberately NOT constrained: the
 * empty string is how "not recorded" is stored there.
 */

describe('the database-level provenance invariants', () => {
  it('refuses an annotation whose actor reference is empty', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      let thrown: unknown;
      try {
        store.db
          .prepare(
            `INSERT INTO annotations (
               id, sample_id, ontology_version_id, label_key, actor_kind,
               actor_ref, surface, session_id, created_at, updated_at
             ) VALUES (
               @id, @sample_id, @ontology_version_id, 'kitchen', 'human',
               '', 'studio', '', @created_at, @created_at
             )`,
          )
          .run({
            id: '01900000-0000-7000-8000-0000000000a1',
            sample_id: sample.id,
            ontology_version_id: ontology.id,
            created_at: '2024-01-01T00:00:00.000Z',
          });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe('SQLITE_CONSTRAINT_CHECK');

      // The row was NOT written.
      const row = store.db
        .prepare('SELECT COUNT(*) AS c FROM annotations')
        .get() as { c: number };
      expect(row.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('refuses an annotation whose surface is empty', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      expect(() =>
        store.db
          .prepare(
            `INSERT INTO annotations (
               id, sample_id, ontology_version_id, label_key, actor_kind,
               actor_ref, surface, session_id, created_at, updated_at
             ) VALUES (
               @id, @sample_id, @ontology_version_id, 'kitchen', 'human',
               'user:erik', '', '', @created_at, @created_at
             )`,
          )
          .run({
            id: '01900000-0000-7000-8000-0000000000a2',
            sample_id: sample.id,
            ontology_version_id: ontology.id,
            created_at: '2024-01-01T00:00:00.000Z',
          }),
      ).toThrow();
    } finally {
      store.cleanup();
    }
  });

  it('refuses a prediction whose actor reference or surface is empty', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const model = store.repos.models.insert(modelVersionFixture());

      const insert = (id: string, actorRef: string, surface: string) =>
        store.db
          .prepare(
            `INSERT INTO predictions (
               id, sample_id, model_version_id, label_key, probability_raw,
               actor_kind, actor_ref, actor_version, surface, session_id,
               created_at, updated_at
             ) VALUES (
               @id, @sample_id, @model_version_id, 'kitchen', 0.9,
               'model', @actor_ref, 'v1', @surface, '',
               @created_at, @created_at
             )`,
          )
          .run({
            id,
            sample_id: sample.id,
            model_version_id: model.id,
            actor_ref: actorRef,
            surface,
            created_at: '2024-01-01T00:00:00.000Z',
          });

      let thrown: unknown;
      try {
        insert('01900000-0000-7000-8000-0000000000a3', '', 'cli');
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string }).code).toBe('SQLITE_CONSTRAINT_CHECK');

      thrown = undefined;
      try {
        insert('01900000-0000-7000-8000-0000000000a4', 'model:gpt-4o', '');
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string }).code).toBe('SQLITE_CONSTRAINT_CHECK');

      const row = store.db.prepare('SELECT COUNT(*) AS c FROM predictions').get() as { c: number };
      expect(row.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('accepts a row whose provenance is complete and whose session is not recorded', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      // The sentinel of the session column is NOT a constraint violation:
      // "no session recorded" is a legitimate state.
      store.db
        .prepare(
          `INSERT INTO annotations (
             id, sample_id, ontology_version_id, label_key, actor_kind,
             actor_ref, surface, session_id, created_at, updated_at
           ) VALUES (
             @id, @sample_id, @ontology_version_id, 'kitchen', 'human',
             'user:erik', 'studio', '', @created_at, @created_at
           )`,
        )
        .run({
          id: '01900000-0000-7000-8000-0000000000a5',
          sample_id: sample.id,
          ontology_version_id: ontology.id,
          created_at: '2024-01-01T00:00:00.000Z',
        });

      const row = store.db
        .prepare('SELECT session_id, actor_ref FROM annotations WHERE id = ?')
        .get('01900000-0000-7000-8000-0000000000a5') as {
        session_id: string;
        actor_ref: string;
      };
      expect(row.session_id).toBe('');
      expect(row.actor_ref).toBe('user:erik');
    } finally {
      store.cleanup();
    }
  });
});
