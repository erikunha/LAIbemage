import { describe, expect, it } from 'vitest';
import { AnnotationSchema, PredictionSchema } from '@master-vision/contracts';
import { StoreValidationError, isStoreValidationError } from '../../src/store/index.js';
import {
  agentRunFixture,
  annotationFixture,
  assetFixture,
  captureSessionFixture,
  createTestStore,
  deploymentFixture,
  derivedArtifactFixture,
  evaluationFixture,
  experimentFixture,
  feedbackFixture,
  modelVersionFixture,
  ontologyFixture,
  predictionFixture,
  sampleFixture,
  snapshotFixture,
} from './helpers.js';

/**
 * The repository layer (spec 002, task 3.2 / US2 scenario 3).
 *
 * Covers: every repository writes and reads back, foreign keys are
 * enforced, provenance is mandatory at BOTH layers (schema and database),
 * `updated_at` bumps on every write, and `label_view` is read-only.
 */
describe('store repositories', () => {
  it('inserts and reads back a row for every aggregate', async () => {
    const store = await createTestStore();
    try {
      const { repos } = store;

      const session = repos.captureSessions.insert(captureSessionFixture());
      expect(repos.captureSessions.getById(session.id)).toEqual(session);

      const asset = repos.assets.insert(assetFixture({ captureSessionId: session.id }));
      expect(repos.assets.getById(asset.id)).toEqual(asset);
      expect(repos.assets.findBySha256(asset.sha256!)?.id).toBe(asset.id);
      expect(repos.assets.listByCaptureSession(session.id)).toHaveLength(1);

      const sample = repos.samples.insert(sampleFixture({ assetId: asset.id }));
      expect(repos.samples.getById(sample.id)).toEqual(sample);
      expect(repos.samples.listByAsset(asset.id)).toHaveLength(1);

      const ontology = repos.ontology.insert(ontologyFixture());
      expect(repos.ontology.getById(ontology.id)).toEqual(ontology);
      expect(repos.ontology.findByFingerprint(ontology.fingerprint)?.id).toBe(ontology.id);

      const annotation = repos.annotations.insert(
        annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
      );
      expect(repos.annotations.getById(annotation.id)).toEqual(annotation);
      expect(repos.annotations.listBySample(sample.id)).toHaveLength(1);

      const experiment = repos.experiments.insert(experimentFixture());
      expect(repos.experiments.getById(experiment.id)).toEqual(experiment);

      const model = repos.models.insert(modelVersionFixture(), {
        experimentRunId: experiment.id,
      });
      expect(repos.models.getById(model.id)).toEqual(model);
      expect(repos.models.findByNameAndVersion(model.name, model.version)?.id).toBe(model.id);
      expect(repos.models.listByExperimentRun(experiment.id)).toHaveLength(1);

      const prediction = repos.predictions.insert(
        predictionFixture({ sampleId: sample.id, modelVersionId: model.id }),
      );
      expect(repos.predictions.getById(prediction.id)).toEqual(prediction);
      expect(repos.predictions.listBySample(sample.id)).toHaveLength(1);
      expect(repos.predictions.listByModelVersion(model.id)).toHaveLength(1);

      const snapshot = repos.snapshots.insert(
        snapshotFixture({ ontologyVersionId: ontology.id }),
      );
      expect(repos.snapshots.getById(snapshot.id)).toEqual(snapshot);
      expect(repos.snapshots.findByManifestHash(snapshot.manifestHash)?.id).toBe(snapshot.id);

      const evaluation = repos.evaluations.insert(
        evaluationFixture({ experimentRunId: experiment.id }),
      );
      expect(repos.evaluations.getById(evaluation.id)).toEqual(evaluation);
      expect(repos.evaluations.listByExperimentRun(experiment.id)).toHaveLength(1);

      const deployment = repos.deployments.insert(
        deploymentFixture({ modelVersionId: model.id }),
      );
      expect(repos.deployments.getById(deployment.id)).toEqual(deployment);
      expect(repos.deployments.listByModelVersion(model.id)).toHaveLength(1);

      const feedback = repos.feedback.insert(feedbackFixture({ sampleId: sample.id }));
      expect(repos.feedback.getById(feedback.id)).toEqual(feedback);
      expect(repos.feedback.listBySample(sample.id)).toHaveLength(1);

      const agentRun = repos.agentRuns.insert(agentRunFixture());
      expect(repos.agentRuns.getById(agentRun.id)).toEqual(agentRun);

      const artifact = repos.derivedArtifacts.insert(
        derivedArtifactFixture({ sourceAssetIds: [asset.id], sourceSnapshotId: snapshot.id }),
        { encoderModelVersionId: model.id },
      );
      expect(repos.derivedArtifacts.getById(artifact.id)).toEqual(artifact);
      expect(repos.derivedArtifacts.listBySourceAsset(asset.id)).toHaveLength(1);
      expect(repos.derivedArtifacts.listBySnapshot(snapshot.id)).toHaveLength(1);
      expect(repos.derivedArtifacts.listByEncoder(model.id)).toHaveLength(1);
    } finally {
      store.cleanup();
    }
  });

  it('enforces foreign keys: a sample pointing at a missing asset is rejected', async () => {
    const store = await createTestStore();
    try {
      const orphan = sampleFixture({ assetId: '01900000-0000-7000-8000-000000000000' });

      // The CONTRACT accepts the payload (the id is well-formed) — the
      // DATABASE is what refuses it. This is the second line of defence.
      expect(() => store.repos.samples.insert(orphan)).toThrow(/FOREIGN KEY/i);

      const rows = store.db.prepare('SELECT COUNT(*) AS c FROM samples').get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('rejects an annotation without provenance at the schema layer', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const { actor, ...withoutActor } = annotationFixture({
        sampleId: sample.id,
        ontologyVersionId: ontology.id,
      });
      expect(actor).toBeDefined();

      let thrown: unknown;
      try {
        store.repos.annotations.insert(withoutActor as never);
      } catch (error) {
        thrown = error;
      }
      expect(isStoreValidationError(thrown)).toBe(true);
      expect((thrown as StoreValidationError).issues.length).toBeGreaterThan(0);

      const rows = store.db.prepare('SELECT COUNT(*) AS c FROM annotations').get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('rejects an annotation without provenance at the DATABASE layer', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      // A raw INSERT that bypasses the repository entirely: the NOT NULL
      // constraints on the provenance columns must reject it.
      let thrown: unknown;
      try {
        store.db
          .prepare(
            `INSERT INTO annotations (
               id, sample_id, ontology_version_id, label_key, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            '01900000-0000-7000-8000-000000000001',
            sample.id,
            ontology.id,
            'kitchen',
            '2024-01-01T00:00:00.000Z',
            '2024-01-01T00:00:00.000Z',
          );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe('SQLITE_CONSTRAINT_NOTNULL');

      const rows = store.db.prepare('SELECT COUNT(*) AS c FROM annotations').get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('rejects a prediction whose actor is not a model at the database layer', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const model = store.repos.models.insert(modelVersionFixture());

      // Constitution II: a human label is an Annotation, never a Prediction.
      let thrown: unknown;
      try {
        store.db
          .prepare(
            `INSERT INTO predictions (
               id, sample_id, model_version_id, label_key, probability_raw,
               actor_kind, actor_ref, actor_version, surface, session_id,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'human', 'user:erik', 'x', 'cli', '', ?, ?)`,
          )
          .run(
            '01900000-0000-7000-8000-000000000002',
            sample.id,
            model.id,
            'kitchen',
            0.5,
            '2024-01-01T00:00:00.000Z',
            '2024-01-01T00:00:00.000Z',
          );
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string }).code).toBe('SQLITE_CONSTRAINT_CHECK');
    } finally {
      store.cleanup();
    }
  });

  it('rejects a prediction without provenance at the schema layer', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const model = store.repos.models.insert(modelVersionFixture());

      // US4: a prediction carries actor + surface + session + timestamp.
      // Without the SURFACE the provenance bundle is incomplete, so the
      // CONTRACT rejects the payload before the database is touched.
      const { surface, ...withoutSurface } = predictionFixture({
        sampleId: sample.id,
        modelVersionId: model.id,
      });
      expect(surface).toBeDefined();

      const contract = PredictionSchema.safeParse(withoutSurface);
      expect(contract.success).toBe(false);
      expect(contract.success ? [] : contract.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'surface',
      );

      let thrown: unknown;
      try {
        store.repos.predictions.insert(withoutSurface as never);
      } catch (error) {
        thrown = error;
      }
      expect(isStoreValidationError(thrown)).toBe(true);
      expect((thrown as StoreValidationError).issues.length).toBeGreaterThan(0);

      const rows = store.db.prepare('SELECT COUNT(*) AS c FROM predictions').get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      store.cleanup();
    }
  });

  it('round-trips a prediction without a session and satisfies the contract', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const model = store.repos.models.insert(modelVersionFixture());

      // The fixture carries a surface but NO session: a batch inference run
      // has no user session, and that must still round-trip.
      const prediction = predictionFixture({ sampleId: sample.id, modelVersionId: model.id });
      expect(prediction.sessionId).toBeUndefined();

      store.repos.predictions.insert(prediction);
      const readBack = store.repos.predictions.getById(prediction.id);

      expect(readBack).toBeDefined();
      // The entity read back from the database SATISFIES the contract.
      expect(PredictionSchema.safeParse(readBack).success).toBe(true);
      // The surface is a real surface, never a fabricated empty string.
      expect(readBack?.surface).toBe('cli');
      // The "no session recorded" sentinel of the NOT NULL column is mapped
      // back to `undefined`, never to an empty session id.
      expect(readBack?.sessionId).toBeUndefined();

      const row = store.db
        .prepare('SELECT surface, session_id FROM predictions WHERE id = ?')
        .get(prediction.id) as { surface: string; session_id: string };
      expect(row.surface).toBe('cli');
      expect(row.session_id).toBe('');
    } finally {
      store.cleanup();
    }
  });

  it('round-trips the session of a prediction', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const model = store.repos.models.insert(modelVersionFixture());

      const prediction = predictionFixture({
        sampleId: sample.id,
        modelVersionId: model.id,
        sessionId: 'session-42',
      });

      store.repos.predictions.insert(prediction);
      const readBack = store.repos.predictions.getById(prediction.id);

      expect(PredictionSchema.safeParse(readBack).success).toBe(true);
      expect(readBack?.sessionId).toBe('session-42');
      expect(readBack?.surface).toBe('cli');
    } finally {
      store.cleanup();
    }
  });

  it('bumps updated_at on every write and leaves created_at alone', async () => {
    const store = await createTestStore();
    try {
      const model = store.repos.models.insert(modelVersionFixture());
      const deployment = store.repos.deployments.insert(
        deploymentFixture({ modelVersionId: model.id }),
      );

      const before = store.db
        .prepare('SELECT created_at, updated_at FROM deployments WHERE id = ?')
        .get(deployment.id) as { created_at: string; updated_at: string };
      expect(before.created_at).toBe(before.updated_at);

      store.repos.deployments.setActive(deployment.id, true);

      const after = store.db
        .prepare('SELECT created_at, updated_at FROM deployments WHERE id = ?')
        .get(deployment.id) as { created_at: string; updated_at: string };
      expect(after.created_at).toBe(before.created_at);
      expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
      expect(store.repos.deployments.getById(deployment.id)?.active).toBe(true);
    } finally {
      store.cleanup();
    }
  });

  it('bumps updated_at when an experiment run changes status', async () => {
    const store = await createTestStore();
    try {
      const run = store.repos.experiments.insert(experimentFixture());
      const before = store.db
        .prepare('SELECT updated_at FROM experiment_runs WHERE id = ?')
        .get(run.id) as { updated_at: string };

      store.repos.experiments.updateStatus(run.id, 'succeeded');

      const after = store.db
        .prepare('SELECT updated_at FROM experiment_runs WHERE id = ?')
        .get(run.id) as { updated_at: string };
      expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
      expect(store.repos.experiments.getById(run.id)?.status).toBe('succeeded');
      expect(store.repos.experiments.getById(run.id)?.endedAt).toBeDefined();
    } finally {
      store.cleanup();
    }
  });

  it('exposes label_view as a read-only join', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());
      const model = store.repos.models.insert(modelVersionFixture());
      store.repos.annotations.insert(
        annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
      );
      store.repos.predictions.insert(
        predictionFixture({ sampleId: sample.id, modelVersionId: model.id }),
      );

      const rows = store.repos.labelView.listBySample(sample.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sampleId).toBe(sample.id);
      expect(rows[0]!.assetId).toBe(asset.id);
      expect(rows[0]!.annotationLabelKey).toBe('kitchen');
      expect(rows[0]!.predictionLabelKey).toBe('kitchen');
      expect(rows[0]!.modelName).toBe(model.name);

      // Read-only BY CONSTRUCTION: SQLite refuses to write to a view.
      expect(() =>
        store.db
          .prepare('INSERT INTO label_view (sample_id, asset_id) VALUES (?, ?)')
          .run(sample.id, asset.id),
      ).toThrow(/cannot modify label_view because it is a view/);
      expect(() =>
        store.db.prepare('UPDATE label_view SET asset_id = ?').run('other'),
      ).toThrow(/cannot modify label_view because it is a view/);
      expect(() => store.db.prepare('DELETE FROM label_view')).toThrow(
        /cannot modify label_view because it is a view/,
      );
    } finally {
      store.cleanup();
    }
  });

  it('keeps Prediction and Annotation apart: a prediction payload is not an annotation', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());
      const model = store.repos.models.insert(modelVersionFixture());

      const prediction = predictionFixture({ sampleId: sample.id, modelVersionId: model.id });

      // A prediction payload carries no ontologyVersionId: it cannot be
      // stored as an annotation.
      expect(AnnotationSchema.safeParse(prediction).success).toBe(false);

      // A model actor cannot author an annotation.
      expect(
        AnnotationSchema.safeParse({
          ...annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
          actor: prediction.actor,
        }).success,
      ).toBe(false);

      // A human actor cannot author a prediction.
      expect(
        PredictionSchema.safeParse({
          ...prediction,
          actor: { kind: 'human', ref: 'user:erik' },
        }).success,
      ).toBe(false);
    } finally {
      store.cleanup();
    }
  });

  it('rejects an unhashed asset that does not use the path-hash placeholder id', async () => {
    const store = await createTestStore();
    try {
      const wrongId = assetFixture({ id: '01900000-0000-7000-8000-000000000003' });
      let thrown: unknown;
      try {
        store.repos.assets.insert({ ...wrongId, sha256: undefined, unhashed: true });
      } catch (error) {
        thrown = error;
      }
      expect(isStoreValidationError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain('path-hash placeholder');
    } finally {
      store.cleanup();
    }
  });
});
