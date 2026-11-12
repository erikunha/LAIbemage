import { describe, expect, it } from 'vitest';
import {
  AssetsRepository,
  StoreValidationError,
  walkArtifactLineage,
  walkPredictionLineage,
} from '../../src/store/index.js';
import {
  agentRunFixture,
  annotationFixture,
  assetFixture,
  createTestStore,
  deploymentFixture,
  derivedArtifactFixture,
  experimentFixture,
  modelVersionFixture,
  ontologyFixture,
  sampleFixture,
} from './helpers.js';

/**
 * The negative paths of the repository layer: a lookup that finds nothing
 * and a write that targets something that does not exist. Every one of them
 * must fail in a way the caller can recognise — never with a silent
 * `undefined` where a row was expected, and never with a raw driver error
 * where the store can explain itself.
 */
describe('store negative paths', () => {
  it('returns undefined for unknown ids', async () => {
    const store = await createTestStore();
    try {
      const { repos } = store;
      const unknown = '01900000-0000-7000-8000-0000000000ee';

      expect(repos.assets.getById(unknown)).toBeUndefined();
      expect(repos.captureSessions.getById(unknown)).toBeUndefined();
      expect(repos.samples.getById(unknown)).toBeUndefined();
      expect(repos.ontology.getById(unknown)).toBeUndefined();
      expect(repos.annotations.getById(unknown)).toBeUndefined();
      expect(repos.predictions.getById(unknown)).toBeUndefined();
      expect(repos.snapshots.getById(unknown)).toBeUndefined();
      expect(repos.experiments.getById(unknown)).toBeUndefined();
      expect(repos.models.getById(unknown)).toBeUndefined();
      expect(repos.evaluations.getById(unknown)).toBeUndefined();
      expect(repos.deployments.getById(unknown)).toBeUndefined();
      expect(repos.feedback.getById(unknown)).toBeUndefined();
      expect(repos.agentRuns.getById(unknown)).toBeUndefined();
      expect(repos.derivedArtifacts.getById(unknown)).toBeUndefined();

      expect(repos.models.findByNameAndVersion('nope', 'nope')).toBeUndefined();
      expect(repos.snapshots.findByManifestHash('f'.repeat(64))).toBeUndefined();
      expect(repos.ontology.findByFingerprint('fp2:nope')).toBeUndefined();
      expect(repos.assets.findBySha256('e'.repeat(64))).toBeUndefined();
      expect(repos.assets.findByPath('/nope.jpg')).toBeUndefined();
      expect(repos.samples.listByAsset(unknown)).toEqual([]);
      expect(repos.annotations.latestForSample(unknown)).toBeUndefined();
      expect(repos.experiments.listBySnapshot(unknown)).toEqual([]);
      expect(repos.derivedArtifacts.listByEncoder(unknown)).toEqual([]);
      expect(repos.derivedArtifacts.listBySnapshot(unknown)).toEqual([]);
      expect(walkPredictionLineage(store.db, unknown)).toBeUndefined();
      expect(walkArtifactLineage(store.db, unknown)).toBeUndefined();
    } finally {
      store.cleanup();
    }
  });

  it('refuses to update a row that does not exist', async () => {
    const store = await createTestStore();
    try {
      const unknown = '01900000-0000-7000-8000-0000000000ef';
      expect(() => store.repos.experiments.updateStatus(unknown, 'succeeded')).toThrow(
        StoreValidationError,
      );
      expect(() => store.repos.deployments.setActive(unknown, true)).toThrow(StoreValidationError);
      expect(() => store.repos.agentRuns.updateStatus(unknown, 'failed')).toThrow(
        StoreValidationError,
      );
      expect(() =>
        store.repos.annotations.correctAnnotation(unknown, annotationFixture()),
      ).toThrow(StoreValidationError);
    } finally {
      store.cleanup();
    }
  });

  it('enforces the unhashed identity rule in every variant', async () => {
    const store = await createTestStore();
    try {
      const asset = assetFixture();

      // unhashed WITH a sha256: the content address is claimed and unknown.
      expect(() =>
        store.repos.assets.insert({ ...asset, id: asset.id, unhashed: true }),
      ).toThrow(/must not carry a sha256/);

      // unhashed WITHOUT a path: there is nothing to derive a placeholder from.
      expect(() =>
        store.repos.assets.insert({
          ...asset,
          id: asset.id,
          sha256: undefined,
          unhashed: true,
          path: undefined,
        }),
      ).toThrow(/must carry the path/);

      // hashed WITHOUT a sha256.
      expect(() => store.repos.assets.insert({ ...asset, sha256: undefined })).toThrow(
        /must carry its sha256/,
      );

      // The correct placeholder id is accepted.
      const placeholder = assetFixture({
        sha256: undefined,
        unhashed: true,
        path: '/tmp/legacy-run/frame-1.jpg',
      });
      const expectedId = AssetsRepository.placeholderIdFor('/tmp/legacy-run/frame-1.jpg');
      const stored = store.repos.assets.insert({ ...placeholder, id: expectedId });
      expect(stored.unhashed).toBe(true);
      expect(stored.sha256).toBeUndefined();
      expect(store.repos.assets.getById(expectedId)?.unhashed).toBe(true);
    } finally {
      store.cleanup();
    }
  });

  it('stamps the explicit end time of a run and the promotion of a deployment', async () => {
    const store = await createTestStore();
    try {
      const run = store.repos.experiments.insert(experimentFixture());
      const ended = store.repos.experiments.updateStatus(run.id, 'failed', '2024-02-02T00:00:00.000Z');
      expect(ended.endedAt).toBe('2024-02-02T00:00:00.000Z');

      const model = store.repos.models.insert(modelVersionFixture());
      const deployment = store.repos.deployments.insert(
        deploymentFixture({ modelVersionId: model.id }),
      );
      const promoted = store.repos.deployments.setActive(
        deployment.id,
        true,
        '2024-03-03T00:00:00.000Z',
      );
      expect(promoted.promotedAt).toBe('2024-03-03T00:00:00.000Z');
    } finally {
      store.cleanup();
    }
  });

  it('round-trips an agent-authored annotation and a derived artifact', async () => {
    const store = await createTestStore();
    try {
      const agentRun = store.repos.agentRuns.insert(agentRunFixture());
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const annotation = store.repos.annotations.insert(
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          actor: { kind: 'agent', ref: 'agent:reviewer-1', agentRunId: agentRun.id },
        }),
      );
      expect(annotation.actor).toEqual({
        kind: 'agent',
        ref: 'agent:reviewer-1',
        agentRunId: agentRun.id,
      });
      expect(store.repos.annotations.getById(annotation.id)?.actor).toEqual(annotation.actor);

      const artifact = store.repos.derivedArtifacts.insert(
        derivedArtifactFixture({
          kind: 'thumbnail',
          sourceAssetIds: [asset.id],
          sourceSnapshotId: undefined,
        }),
      );
      expect(artifact.sourceSnapshotId).toBeUndefined();
      expect(store.repos.derivedArtifacts.getById(artifact.id)?.sourceAssetIds).toEqual([asset.id]);
    } finally {
      store.cleanup();
    }
  });
});
