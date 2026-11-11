import { describe, expect, it } from 'vitest';
import { AnnotationSchema, ENTITY_SCHEMAS, PredictionSchema } from '@master-vision/contracts';
import {
  NOT_RECORDED,
  StoreValidationError,
  optionalText,
  sentinelText,
} from '../../src/store/index.js';
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
 * The "not recorded" sentinel and the round trip (constitution II).
 *
 * A contract field that is OPTIONAL (`sessionId` on an annotation and on a
 * prediction) lives in a NOT NULL column. The column stores the empty string
 * as the "not recorded" sentinel — a storage detail that must NEVER reach a
 * caller as a value.
 *
 * The defect this file locks down: the sentinel was read back as `''`, so an
 * entity read from the database did not satisfy its own contract schema
 * (`PredictionSchema.safeParse` failed with "Invalid option: expected one of
 * cli|studio|api|mcp|agent"). The write path was fine; the READ path leaked.
 *
 * These tests are the regression net for the whole store: every entity is
 * read back and re-parsed with its own contract schema, and the two columns
 * that can carry the sentinel (`annotations.session_id`,
 * `predictions.session_id` / `predictions.surface`) are checked explicitly.
 */

/** A `SqliteError` carries a `code`; the store's own errors do not. */
function isConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

describe('the not-recorded sentinel', () => {
  it('maps the sentinel to undefined in both directions', () => {
    expect(NOT_RECORDED).toBe('');

    // Write side: an absent optional field becomes the sentinel.
    expect(sentinelText(undefined)).toBe('');
    expect(sentinelText('session-1')).toBe('session-1');

    // Read side: the sentinel becomes ABSENT, never a value.
    expect(optionalText('')).toBeUndefined();
    expect(optionalText(null)).toBeUndefined();
    expect(optionalText(undefined)).toBeUndefined();
    expect(optionalText(42)).toBeUndefined();
    expect(optionalText('session-1')).toBe('session-1');
  });

  it('reads an annotation whose session was not recorded back as absent', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const annotation = store.repos.annotations.insert(
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          sessionId: undefined,
        }),
      );

      // The column really holds the sentinel…
      const raw = store.db
        .prepare('SELECT session_id FROM annotations WHERE id = ?')
        .get(annotation.id) as { session_id: string };
      expect(raw.session_id).toBe('');

      // …and the entity reads back as ABSENT, not as an empty session id.
      const readBack = store.repos.annotations.getById(annotation.id)!;
      expect(readBack.sessionId).toBeUndefined();
      expect(readBack.sessionId).not.toBe('');
      expect(AnnotationSchema.safeParse(readBack).success).toBe(true);
    } finally {
      store.cleanup();
    }
  });

  it('never leaks the sentinel through the label view', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      store.repos.annotations.insert(
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          sessionId: undefined,
        }),
      );

      const rows = store.repos.labelView.listBySample(sample.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.annotationSessionId).toBeUndefined();
      expect(rows[0]!.annotationSessionId).not.toBe('');
    } finally {
      store.cleanup();
    }
  });

  it('reads a prediction back without the sentinel', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const model = store.repos.models.insert(modelVersionFixture());

      const prediction = store.repos.predictions.insert(
        predictionFixture({ sampleId: sample.id, modelVersionId: model.id }),
      );

      const readBack = store.repos.predictions.getById(prediction.id)!;
      expect(readBack.surface).not.toBe('');
      expect(PredictionSchema.safeParse(readBack).success).toBe(true);
    } finally {
      store.cleanup();
    }
  });

  it('refuses a prediction whose surface was not recorded', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const model = store.repos.models.insert(modelVersionFixture());

      let stored;
      try {
        stored = store.repos.predictions.insert(
          predictionFixture({
            sampleId: sample.id,
            modelVersionId: model.id,
            surface: undefined,
          }),
        );
      } catch (error) {
        // The invariant is enforced EITHER by the contract (once `surface` is
        // required there) OR by the database CHECK — never silently.
        expect(
          error instanceof StoreValidationError || isConstraintError(error),
          `unexpected error: ${String(error)}`,
        ).toBe(true);
        return;
      }

      // If the write went through, the sentinel must not survive the read.
      const readBack = store.repos.predictions.getById(stored.id)!;
      expect(readBack.surface).toBeUndefined();
      expect(readBack.surface).not.toBe('');
      expect(PredictionSchema.safeParse(readBack).success).toBe(true);
    } finally {
      store.cleanup();
    }
  });

  it('reads every entity back into its own contract schema', async () => {
    const store = await createTestStore();
    try {
      const { repos } = store;

      const asset = repos.assets.insert(assetFixture());
      const session = repos.captureSessions.insert(captureSessionFixture());
      const sample = repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = repos.ontology.insert(ontologyFixture());
      const annotation = repos.annotations.insert(
        annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
      );
      const model = repos.models.insert(modelVersionFixture());
      const prediction = repos.predictions.insert(
        predictionFixture({ sampleId: sample.id, modelVersionId: model.id }),
      );
      const snapshot = repos.snapshots.insert(
        snapshotFixture({ ontologyVersionId: ontology.id }),
      );
      const experiment = repos.experiments.insert(experimentFixture());
      const evaluation = repos.evaluations.insert(
        evaluationFixture({ experimentRunId: experiment.id }),
      );
      const deployment = repos.deployments.insert(
        deploymentFixture({ modelVersionId: model.id }),
      );
      const feedback = repos.feedback.insert(feedbackFixture({ sampleId: sample.id }));
      const agentRun = repos.agentRuns.insert(agentRunFixture());
      const artifact = repos.derivedArtifacts.insert(
        derivedArtifactFixture({ sourceAssetIds: [asset.id] }),
      );

      const cases: { name: keyof typeof ENTITY_SCHEMAS; readBack: unknown }[] = [
        { name: 'Asset', readBack: repos.assets.getById(asset.id) },
        { name: 'CaptureSession', readBack: repos.captureSessions.getById(session.id) },
        { name: 'Sample', readBack: repos.samples.getById(sample.id) },
        { name: 'OntologyVersion', readBack: repos.ontology.getById(ontology.id) },
        { name: 'Annotation', readBack: repos.annotations.getById(annotation.id) },
        { name: 'Prediction', readBack: repos.predictions.getById(prediction.id) },
        { name: 'DatasetSnapshot', readBack: repos.snapshots.getById(snapshot.id) },
        { name: 'ExperimentRun', readBack: repos.experiments.getById(experiment.id) },
        { name: 'ModelVersion', readBack: repos.models.getById(model.id) },
        { name: 'EvaluationRun', readBack: repos.evaluations.getById(evaluation.id) },
        { name: 'Deployment', readBack: repos.deployments.getById(deployment.id) },
        { name: 'FeedbackEvent', readBack: repos.feedback.getById(feedback.id) },
        { name: 'AgentRun', readBack: repos.agentRuns.getById(agentRun.id) },
        { name: 'DerivedArtifact', readBack: repos.derivedArtifacts.getById(artifact.id) },
      ];

      expect(cases).toHaveLength(14);
      for (const { name, readBack } of cases) {
        const schema = ENTITY_SCHEMAS[name] as { safeParse: (value: unknown) => { success: boolean } };
        const result = schema.safeParse(readBack);
        expect(result.success, `${name} did not satisfy its contract schema`).toBe(true);
      }
    } finally {
      store.cleanup();
    }
  });
});
