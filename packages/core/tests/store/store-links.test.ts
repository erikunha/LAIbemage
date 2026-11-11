import { describe, expect, it } from 'vitest';
import { StoreValidationError } from '../../src/store/index.js';
import {
  assetFixture,
  createTestStore,
  derivedArtifactFixture,
  modelVersionFixture,
  ontologyFixture,
  sampleFixture,
  snapshotFixture,
} from './helpers.js';

/**
 * The store-owned links are validated by the store, not by the driver.
 *
 * Two kinds of link carry no foreign key of their own, or carry one whose
 * violation would surface as a raw driver error:
 *
 *  - `model_versions.experiment_run_id` and
 *    `derived_artifacts.encoder_model_version_id` are STORE-OWNED link
 *    columns (the contracts have no such pointer). A typo in them used to
 *    produce a raw `SQLITE_CONSTRAINT_FOREIGNKEY` — an error that names the
 *    constraint but not the mistake.
 *  - `samples.snapshot_ids_json` is a JSON array and therefore cannot carry a
 *    foreign key at all. A phantom snapshot id was accepted, and the auditor
 *    walk of that snapshot silently returned nothing.
 *  - `derived_artifacts.source_snapshot_id` is a CONTRACT field with a real
 *    foreign key. A typo in it surfaced as a raw `SQLITE_CONSTRAINT_FOREIGNKEY`
 *    from the driver — the same mistake, in the same direction.
 *
 * Both are now rejected with the store's own error class, BEFORE the write.
 */

/** A raw driver error carries a `code`; the store's own errors do not. */
function isDriverError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE_')
  );
}

describe('the store-owned links', () => {
  it('refuses a model version that links to an unknown experiment run', async () => {
    const store = await createTestStore();
    try {
      let thrown: unknown;
      try {
        store.repos.models.insert(modelVersionFixture(), {
          experimentRunId: '01900000-0000-7000-8000-0000000000b1',
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreValidationError);
      expect((thrown as Error).message).toContain('experiment run');
      // The store's own error, not a raw driver error.
      expect(isDriverError(thrown)).toBe(false);

      // Nothing was written.
      const row = store.db.prepare('SELECT COUNT(*) AS c FROM model_versions').get() as {
        c: number;
      };
      expect(row.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('refuses a derived artifact that links to an unknown encoder', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());

      let thrown: unknown;
      try {
        store.repos.derivedArtifacts.insert(
          derivedArtifactFixture({ sourceAssetIds: [asset.id] }),
          { encoderModelVersionId: '01900000-0000-7000-8000-0000000000b2' },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreValidationError);
      expect((thrown as Error).message).toContain('encoder model version');
      expect(isDriverError(thrown)).toBe(false);

      const row = store.db.prepare('SELECT COUNT(*) AS c FROM derived_artifacts').get() as {
        c: number;
      };
      expect(row.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('refuses a sample that claims a snapshot membership that does not exist', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const phantom = '01900000-0000-7000-8000-0000000000b3';

      let thrown: unknown;
      try {
        store.repos.samples.insert(
          sampleFixture({ assetId: asset.id, snapshotIds: [phantom] }),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreValidationError);
      expect((thrown as Error).message).toContain(phantom);
      expect(isDriverError(thrown)).toBe(false);

      // The phantom membership did not land.
      const row = store.db.prepare('SELECT COUNT(*) AS c FROM samples').get() as { c: number };
      expect(row.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('accepts a snapshot membership that exists', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const ontology = store.repos.ontology.insert(ontologyFixture());
      const snapshot = store.repos.snapshots.insert(
        snapshotFixture({ ontologyVersionId: ontology.id }),
      );

      const sample = store.repos.samples.insert(
        sampleFixture({ assetId: asset.id, snapshotIds: [snapshot.id] }),
      );
      expect(store.repos.samples.listBySnapshot(snapshot.id).map((entry) => entry.id)).toEqual([
        sample.id,
      ]);
    } finally {
      store.cleanup();
    }
  });

  it('refuses a derived artifact whose source snapshot does not exist', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const phantom = '01900000-0000-7000-8000-0000000000b4';

      let thrown: unknown;
      try {
        store.repos.derivedArtifacts.insert(
          derivedArtifactFixture({ sourceAssetIds: [asset.id], sourceSnapshotId: phantom }),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreValidationError);
      // The error names the missing snapshot id.
      expect((thrown as Error).message).toContain(phantom);
      // The store's own error, not a raw driver error.
      expect(isDriverError(thrown)).toBe(false);

      // The phantom snapshot id did not land.
      const row = store.db.prepare('SELECT COUNT(*) AS c FROM derived_artifacts').get() as {
        c: number;
      };
      expect(row.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('accepts a derived artifact whose source snapshot exists', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const ontology = store.repos.ontology.insert(ontologyFixture());
      const snapshot = store.repos.snapshots.insert(
        snapshotFixture({ ontologyVersionId: ontology.id }),
      );

      const artifact = store.repos.derivedArtifacts.insert(
        derivedArtifactFixture({ sourceAssetIds: [asset.id], sourceSnapshotId: snapshot.id }),
      );

      expect(artifact.sourceSnapshotId).toBe(snapshot.id);
      const read = store.repos.derivedArtifacts.getById(artifact.id);
      expect(read?.sourceSnapshotId).toBe(snapshot.id);
      expect(store.repos.derivedArtifacts.listBySnapshot(snapshot.id).map((entry) => entry.id)).toEqual([
        artifact.id,
      ]);
    } finally {
      store.cleanup();
    }
  });
});
