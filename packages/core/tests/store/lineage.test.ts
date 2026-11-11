import { describe, expect, it } from 'vitest';
import {
  isStoreConsistencyError,
  isStoreValidationError,
  StoreConsistencyError,
  walkArtifactLineage,
  walkPredictionLineage,
} from '../../src/store/index.js';
import {
  assetFixture,
  createTestStore,
  derivedArtifactFixture,
  experimentFixture,
  modelVersionFixture,
  ontologyFixture,
  predictionFixture,
  sampleFixture,
  snapshotFixture,
} from './helpers.js';

/**
 * Lineage invariants and the auditor walk (spec 002, US4, tasks 5.1 / 5.2).
 *
 * The walk is the acceptance test of the whole store: pick any prediction,
 * reach its model version, its experiment run, its snapshot and the assets
 * that snapshot contains — with real SQL joins, not application-side
 * stitching.
 */
describe('lineage and the auditor walk', () => {
  it('rejects a derived artifact without lineage', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());

      // Missing source asset ids.
      const { sourceAssetIds, ...withoutSources } = derivedArtifactFixture();
      expect(sourceAssetIds).toBeDefined();
      expect(() => store.repos.derivedArtifacts.insert(withoutSources as never)).toThrow();

      // Empty source list.
      expect(() =>
        store.repos.derivedArtifacts.insert(derivedArtifactFixture({ sourceAssetIds: [] })),
      ).toThrow();

      // Missing transform fingerprint.
      const { transformFingerprint, ...withoutFingerprint } = derivedArtifactFixture({
        sourceAssetIds: [asset.id],
      });
      expect(transformFingerprint).toBeDefined();
      expect(() =>
        store.repos.derivedArtifacts.insert(withoutFingerprint as never),
      ).toThrow();

      // Missing transform.
      const { transform, ...withoutTransform } = derivedArtifactFixture({
        sourceAssetIds: [asset.id],
      });
      expect(transform).toBeDefined();
      expect(() => store.repos.derivedArtifacts.insert(withoutTransform as never)).toThrow();

      // A source that does not exist: the JSON array cannot carry a foreign
      // key, so the repository checks it (lineage is structural).
      let thrown: unknown;
      try {
        store.repos.derivedArtifacts.insert(
          derivedArtifactFixture({
            sourceAssetIds: ['01900000-0000-7000-8000-0000000000ff'],
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(isStoreValidationError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('unknown source asset');

      const rows = store.db
        .prepare('SELECT COUNT(*) AS c FROM derived_artifacts')
        .get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('rejects a derived artifact whose lineage is empty AT THE DATABASE LEVEL', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());

      let thrown: unknown;
      try {
        store.db
          .prepare(
            `INSERT INTO derived_artifacts (
               id, kind, source_asset_ids_json, transform, transform_fingerprint,
               created_at, updated_at
             ) VALUES (?, 'embedding', '[]', 'embedding:x', 'fp2:abc', ?, ?)`,
          )
          .run(
            '01900000-0000-7000-8000-0000000000aa',
            '2024-01-01T00:00:00.000Z',
            '2024-01-01T00:00:00.000Z',
          );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe('SQLITE_CONSTRAINT_CHECK');
      expect(asset.id).toBeDefined();
    } finally {
      store.cleanup();
    }
  });

  it('walks Prediction → ModelVersion → ExperimentRun → Snapshot → Assets', async () => {
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
      const experiment = store.repos.experiments.insert(
        experimentFixture({ kind: 'train', inputSnapshotId: snapshot.id }),
      );
      const model = store.repos.models.insert(modelVersionFixture(), {
        experimentRunId: experiment.id,
      });
      const prediction = store.repos.predictions.insert(
        predictionFixture({ sampleId: sample.id, modelVersionId: model.id }),
      );

      const lineage = walkPredictionLineage(store.db, prediction.id);
      expect(lineage).toBeDefined();
      expect(lineage!.prediction.id).toBe(prediction.id);
      expect(lineage!.modelVersion.id).toBe(model.id);
      expect(lineage!.modelVersion.name).toBe(model.name);
      expect(lineage!.experimentRun?.id).toBe(experiment.id);
      expect(lineage!.experimentRun?.configFingerprint).toBe(experiment.configFingerprint);
      expect(lineage!.snapshot?.id).toBe(snapshot.id);
      expect(lineage!.snapshot?.manifestHash).toBe(snapshot.manifestHash);
      expect(lineage!.samples.map((entry) => entry.id)).toEqual([sample.id]);
      expect(lineage!.assets.map((entry) => entry.id)).toEqual([asset.id]);
      expect(lineage!.assets[0]!.sha256).toBe(asset.sha256);
    } finally {
      store.cleanup();
    }
  });

  it('walks an embedding artifact → its encoder + snapshot + source assets', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const ontology = store.repos.ontology.insert(ontologyFixture());
      const snapshot = store.repos.snapshots.insert(
        snapshotFixture({ ontologyVersionId: ontology.id }),
      );
      const experiment = store.repos.experiments.insert(
        experimentFixture({ kind: 'train', inputSnapshotId: snapshot.id }),
      );
      const encoder = store.repos.models.insert(
        modelVersionFixture({ name: 'text-embedding-3-small', version: 'v1' }),
        { experimentRunId: experiment.id },
      );

      const artifact = store.repos.derivedArtifacts.insert(
        derivedArtifactFixture({
          kind: 'embedding',
          sourceAssetIds: [asset.id],
          sourceSnapshotId: snapshot.id,
          transform: 'embedding:text-embedding-3-small',
        }),
        { encoderModelVersionId: encoder.id },
      );

      const lineage = walkArtifactLineage(store.db, artifact.id);
      expect(lineage).toBeDefined();
      expect(lineage!.artifact.id).toBe(artifact.id);
      expect(lineage!.encoder?.id).toBe(encoder.id);
      expect(lineage!.encoder?.name).toBe('text-embedding-3-small');
      expect(lineage!.snapshot?.id).toBe(snapshot.id);
      expect(lineage!.assets.map((entry) => entry.id)).toEqual([asset.id]);
    } finally {
      store.cleanup();
    }
  });

  it('returns undefined for an unknown prediction', async () => {
    const store = await createTestStore();
    try {
      expect(walkPredictionLineage(store.db, '01900000-0000-7000-8000-0000000000bb')).toBeUndefined();
    } finally {
      store.cleanup();
    }
  });

  it('fails loudly with a store consistency error when the chain is broken', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));

      // The foreign keys are switched off for this one statement, to plant
      // the single inconsistency the schema itself forbids: a prediction
      // whose model version does not exist.
      const orphan = '01900000-0000-7000-8000-0000000000cc';
      store.db.pragma('foreign_keys = OFF');
      try {
        store.db
          .prepare(
            `INSERT INTO predictions (
               id, sample_id, model_version_id, label_key, probability_raw,
               actor_kind, actor_ref, actor_version, surface, session_id,
               created_at, updated_at
             ) VALUES (
               @id, @sample_id, '01900000-0000-7000-8000-0000000000dd',
               'kitchen', 0.9, 'model', 'model:gpt-4o', 'v1', 'cli', '',
               @created_at, @created_at
             )`,
          )
          .run({
            id: orphan,
            sample_id: sample.id,
            created_at: '2024-01-01T00:00:00.000Z',
          });
      } finally {
        store.db.pragma('foreign_keys = ON');
      }

      let thrown: unknown;
      try {
        walkPredictionLineage(store.db, orphan);
      } catch (error) {
        thrown = error;
      }

      // A store error class, not a bare `Error`: the caller can tell a broken
      // database from a broken payload.
      expect(thrown).toBeInstanceOf(StoreConsistencyError);
      expect(isStoreConsistencyError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('no model version');
    } finally {
      store.cleanup();
    }
  });
});
