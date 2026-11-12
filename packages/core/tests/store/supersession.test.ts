import { describe, expect, it } from 'vitest';
import {
  assertSupersedeTarget,
  newEntityId,
  StoreValidationError,
} from '../../src/store/index.js';
import {
  annotationFixture,
  assetFixture,
  createTestStore,
  ontologyFixture,
  sampleFixture,
} from './helpers.js';

/**
 * Supersession (spec 002, FR-006, task 3.4, US4 scenario 2).
 *
 * A correction is a NEW row; the row it replaces keeps its provenance
 * forever. These tests prove both halves: the new row exists, and the old
 * row's actor / surface / session / createdAt are untouched.
 */
describe('annotation supersession', () => {
  it('inserts a new row and marks the old one as superseded', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const original = store.repos.annotations.insert(
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          labelKey: 'kitchen',
          actor: { kind: 'human', ref: 'user:erik', displayName: 'Erik' },
          surface: 'studio',
          sessionId: 'session-1',
          createdAt: '2024-01-01T00:00:00.000Z',
        }),
      );

      const correction = store.repos.annotations.correctAnnotation(
        original.id,
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          labelKey: 'bathroom',
          actor: { kind: 'human', ref: 'user:marta', displayName: 'Marta' },
          surface: 'cli',
          sessionId: 'session-2',
          createdAt: '2024-06-01T00:00:00.000Z',
        }),
      );

      // The new row exists…
      const inserted = store.repos.annotations.getById(correction.id);
      expect(inserted).toBeDefined();
      expect(inserted!.labelKey).toBe('bathroom');
      expect(inserted!.supersededBy).toBeUndefined();

      // …and the old row points at it.
      const superseded = store.repos.annotations.getById(original.id);
      expect(superseded!.supersededBy).toBe(correction.id);
    } finally {
      store.cleanup();
    }
  });

  it('never mutates the provenance of the superseded annotation', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const original = store.repos.annotations.insert(
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          labelKey: 'kitchen',
          actor: { kind: 'human', ref: 'user:erik', displayName: 'Erik' },
          surface: 'studio',
          sessionId: 'session-1',
          createdAt: '2024-01-01T00:00:00.000Z',
        }),
      );

      const before = store.db
        .prepare(
          `SELECT actor_kind, actor_ref, actor_display_name, surface, session_id,
                  created_at, label_key
             FROM annotations WHERE id = ?`,
        )
        .get(original.id) as Record<string, unknown>;

      store.repos.annotations.correctAnnotation(
        original.id,
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          labelKey: 'bathroom',
          actor: { kind: 'agent', ref: 'agent:reviewer-1' },
          surface: 'cli',
          createdAt: '2024-06-01T00:00:00.000Z',
        }),
      );

      const after = store.db
        .prepare(
          `SELECT actor_kind, actor_ref, actor_display_name, surface, session_id,
                  created_at, label_key
             FROM annotations WHERE id = ?`,
        )
        .get(original.id) as Record<string, unknown>;

      // Provenance and the original label are byte-identical.
      expect(after['actor_kind']).toBe(before['actor_kind']);
      expect(after['actor_ref']).toBe(before['actor_ref']);
      expect(after['actor_display_name']).toBe(before['actor_display_name']);
      expect(after['surface']).toBe(before['surface']);
      expect(after['session_id']).toBe(before['session_id']);
      expect(after['created_at']).toBe(before['created_at']);
      expect(after['label_key']).toBe(before['label_key']);
    } finally {
      store.cleanup();
    }
  });

  it('returns the full chain in order', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const first = store.repos.annotations.insert(
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          labelKey: 'kitchen',
          createdAt: '2024-01-01T00:00:00.000Z',
        }),
      );
      const second = store.repos.annotations.correctAnnotation(
        first.id,
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          labelKey: 'bathroom',
          createdAt: '2024-02-01T00:00:00.000Z',
        }),
      );
      const third = store.repos.annotations.correctAnnotation(
        second.id,
        annotationFixture({
          sampleId: sample.id,
          ontologyVersionId: ontology.id,
          labelKey: 'living-room',
          createdAt: '2024-03-01T00:00:00.000Z',
        }),
      );

      const history = store.repos.annotations.annotationHistory(sample.id);
      expect(history.map((annotation) => annotation.id)).toEqual([first.id, second.id, third.id]);
      expect(history.map((annotation) => annotation.labelKey)).toEqual([
        'kitchen',
        'bathroom',
        'living-room',
      ]);
      expect(history[0]!.supersededBy).toBe(second.id);
      expect(history[1]!.supersededBy).toBe(third.id);
      expect(history[2]!.supersededBy).toBeUndefined();

      // The annotation currently in force is the last one.
      expect(store.repos.annotations.latestForSample(sample.id)?.id).toBe(third.id);
    } finally {
      store.cleanup();
    }
  });

  it('refuses to correct an annotation twice and to correct a foreign sample', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const otherSample = store.repos.samples.insert(
        sampleFixture({ assetId: asset.id, id: newEntityId() }),
      );
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const original = store.repos.annotations.insert(
        annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
      );
      store.repos.annotations.correctAnnotation(
        original.id,
        annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
      );

      // Correcting an already superseded row would fork the chain.
      expect(() =>
        store.repos.annotations.correctAnnotation(
          original.id,
          annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
        ),
      ).toThrow(StoreValidationError);

      // A correction must stay on the same sample.
      expect(() =>
        store.repos.annotations.correctAnnotation(
          original.id,
          annotationFixture({ sampleId: otherSample.id, ontologyVersionId: ontology.id }),
        ),
      ).toThrow(StoreValidationError);
    } finally {
      store.cleanup();
    }
  });

  it('refuses an insert that carries a caller-supplied supersededBy pointer', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const otherSample = store.repos.samples.insert(
        sampleFixture({ assetId: asset.id, id: newEntityId() }),
      );
      const ontology = store.repos.ontology.insert(ontologyFixture());

      // The pointer would point at an annotation of ANOTHER sample: the
      // repository refuses it, because the pointer is a fact about the chain
      // that only the repository can know.
      const foreign = store.repos.annotations.insert(
        annotationFixture({ sampleId: otherSample.id, ontologyVersionId: ontology.id }),
      );

      let thrown: unknown;
      try {
        store.repos.annotations.insert(
          annotationFixture({
            sampleId: sample.id,
            ontologyVersionId: ontology.id,
            supersededBy: foreign.id,
          }),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreValidationError);
      expect((thrown as Error).message).toMatch(/supersededBy pointer/);

      // The row was NOT written — and the sample keeps its label in force.
      const rows = store.db
        .prepare('SELECT COUNT(*) AS c FROM annotations WHERE sample_id = ?')
        .get(sample.id) as { c: number };
      expect(rows.c).toBe(0);
      expect(store.repos.annotations.latestForSample(sample.id)).toBeUndefined();
    } finally {
      store.cleanup();
    }
  });

  it('never leaves a sample without an annotation in force', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const first = store.repos.annotations.insert(
        annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
      );
      expect(store.repos.annotations.latestForSample(sample.id)?.id).toBe(first.id);

      // A correction moves the pointer to the new row: the sample ALWAYS has
      // exactly one annotation in force.
      const second = store.repos.annotations.correctAnnotation(
        first.id,
        annotationFixture({ sampleId: sample.id, ontologyVersionId: ontology.id }),
      );
      expect(store.repos.annotations.latestForSample(sample.id)?.id).toBe(second.id);

      const inForce = store.db
        .prepare('SELECT COUNT(*) AS c FROM annotations WHERE sample_id = ? AND superseded_by IS NULL')
        .get(sample.id) as { c: number };
      expect(inForce.c).toBe(1);

      // The only way to void a sample is a caller-supplied pointer — refused.
      expect(() =>
        store.repos.annotations.insert(
          annotationFixture({
            sampleId: sample.id,
            ontologyVersionId: ontology.id,
            supersededBy: second.id,
          }),
        ),
      ).toThrow(StoreValidationError);
      expect(store.repos.annotations.latestForSample(sample.id)?.id).toBe(second.id);
    } finally {
      store.cleanup();
    }
  });

  it('refuses a supersede pointer that points nowhere or at another sample', async () => {
    const store = await createTestStore();
    try {
      const asset = store.repos.assets.insert(assetFixture());
      const sample = store.repos.samples.insert(sampleFixture({ assetId: asset.id }));
      const otherSample = store.repos.samples.insert(
        sampleFixture({ assetId: asset.id, id: newEntityId() }),
      );
      const ontology = store.repos.ontology.insert(ontologyFixture());

      const foreign = store.repos.annotations.insert(
        annotationFixture({ sampleId: otherSample.id, ontologyVersionId: ontology.id }),
      );

      // A pointer to a row that does not exist.
      expect(() =>
        assertSupersedeTarget(store.db, '01900000-0000-7000-8000-0000000000c1', sample.id),
      ).toThrow(StoreValidationError);

      // A pointer to a row of another sample.
      expect(() => assertSupersedeTarget(store.db, foreign.id, sample.id)).toThrow(
        StoreValidationError,
      );

      // The valid case is accepted.
      expect(() => assertSupersedeTarget(store.db, foreign.id, otherSample.id)).not.toThrow();
    } finally {
      store.cleanup();
    }
  });
});
