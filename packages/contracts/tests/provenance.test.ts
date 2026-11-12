import { describe, expect, it } from 'vitest';
import {
  AnnotationSchema,
  ModelActorSchema,
  PredictionSchema,
  TimestampSchema,
} from '../src/index.js';

/**
 * The provenance bundle on every label (spec 002 US4, constitution II).
 *
 * Constitution II says: "Every label carries provenance: actor (human
 * identity or `model:<id>@<version>`), tool surface (CLI/Studio/API/MCP/agent),
 * timestamp and session."
 *
 * So BOTH label schemas carry the same four facts — and a contract that
 * leaves the surface or the session out would let a record be written with
 * half its provenance, which is exactly what the review found in `Prediction`.
 *
 * The tests below assert the SHAPE of the bundle and the SHAPE of a refusal:
 * a forbidden payload must fail, and the failure must be asserted on the
 * issue path (and message), not merely on "it threw".
 */

const IDS = {
  prediction: '018f4e2a-1b2c-7d3e-8f40-1234567890ab',
  sample: '018f4e2a-1b2c-7d3e-8f40-1234567890ac',
  modelVersion: '018f4e2a-1b2c-7d3e-8f40-1234567890ad',
  ontologyVersion: '018f4e2a-1b2c-7d3e-8f40-1234567890ae',
  annotation: '018f4e2a-1b2c-7d3e-8f40-1234567890af',
};

const VALID_PREDICTION = {
  id: IDS.prediction,
  sampleId: IDS.sample,
  modelVersionId: IDS.modelVersion,
  labelKey: 'kitchen',
  probabilityRaw: 0.82,
  actor: { kind: 'model', ref: 'model:gpt-4o', version: '2024-05-13' },
  surface: 'cli',
  createdAt: '2026-11-10T12:00:00.000Z',
};

const VALID_ANNOTATION = {
  id: IDS.annotation,
  sampleId: IDS.sample,
  ontologyVersionId: IDS.ontologyVersion,
  labelKey: 'kitchen',
  actor: { kind: 'human', ref: 'user:erik', displayName: 'Erik' },
  surface: 'studio',
  createdAt: '2026-11-10T12:05:00.000Z',
};

/** The paths of the issues reported for a rejected payload. */
function issuePaths(result: {
  success: boolean;
  error?: { issues: Array<{ path: PropertyKey[] }> };
}) {
  return result.success ? [] : result.error!.issues.map((issue) => issue.path.join('.'));
}

describe('Prediction carries the full US4 provenance bundle', () => {
  it('accepts a prediction with a surface and no session', () => {
    const result = PredictionSchema.safeParse(VALID_PREDICTION);

    expect(result.success).toBe(true);
  });

  it('accepts a prediction with a surface AND a session', () => {
    const result = PredictionSchema.safeParse({
      ...VALID_PREDICTION,
      sessionId: 'session-42',
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.sessionId).toBe('session-42');
  });

  it('rejects a prediction WITHOUT a surface', () => {
    const { surface, ...withoutSurface } = VALID_PREDICTION;
    expect(surface).toBeDefined();

    const result = PredictionSchema.safeParse(withoutSurface);

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('surface');
  });

  it('rejects a prediction with an unknown surface', () => {
    const result = PredictionSchema.safeParse({ ...VALID_PREDICTION, surface: 'telepathy' });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('surface');
  });

  it('rejects an empty session id', () => {
    const result = PredictionSchema.safeParse({ ...VALID_PREDICTION, sessionId: '' });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('sessionId');
  });

  it('parses to the same provenance fields an annotation carries', () => {
    // Parity: the two label kinds carry the same four facts (actor, surface,
    // session, timestamp) — the difference between them is the LABEL KIND,
    // not the completeness of the provenance.
    const prediction = PredictionSchema.parse({ ...VALID_PREDICTION, sessionId: 'session-42' });
    const annotation = AnnotationSchema.parse({ ...VALID_ANNOTATION, sessionId: 'session-42' });

    for (const field of ['actor', 'surface', 'sessionId', 'createdAt']) {
      expect(prediction, `the prediction has no ${field}`).toHaveProperty(field);
      expect(annotation, `the annotation has no ${field}`).toHaveProperty(field);
    }
    expect(prediction.actor.kind).toBe('model');
    expect(annotation.actor.kind).toBe('human');
    // The surfaces may differ; what matters is that BOTH carry one.
    expect(prediction.surface).toBeTruthy();
    expect(annotation.surface).toBeTruthy();
    expect(prediction.sessionId).toBe(annotation.sessionId);
    // Both carry a point in time (the VALUES differ, the FIELD does not).
    expect(Date.parse(prediction.createdAt)).not.toBeNaN();
    expect(Date.parse(annotation.createdAt)).not.toBeNaN();
  });
});

describe('the model actor reference convention (constitution II)', () => {
  it('accepts the bare `model:<id>` form', () => {
    expect(ModelActorSchema.safeParse({ kind: 'model', ref: 'model:gpt-4o', version: '1' }).success).toBe(
      true,
    );
  });

  it('accepts the constitutional `model:<id>@<version>` form', () => {
    const result = ModelActorSchema.safeParse({
      kind: 'model',
      ref: 'model:gpt-4o@2024-01',
      version: '2024-01',
    });

    expect(result.success).toBe(true);
  });

  it('accepts a provider-qualified `model:<provider/model>@<version>` ref', () => {
    const result = ModelActorSchema.safeParse({
      kind: 'model',
      ref: 'model:openai/gpt-4o@2024-05-13',
      version: '2024-05-13',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a ref without the `model:` prefix', () => {
    const result = ModelActorSchema.safeParse({ kind: 'model', ref: 'gpt-4o', version: '1' });

    expect(result.success).toBe(false);
    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue?.path).toEqual(['ref']);
    expect(issue?.message).toContain('model:<id>@<version>');
  });

  it('rejects a ref with whitespace', () => {
    const result = ModelActorSchema.safeParse({
      kind: 'model',
      ref: 'model:gpt 4o',
      version: '1',
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('ref');
  });

  it('rejects a ref with an empty id or an empty version', () => {
    expect(ModelActorSchema.safeParse({ kind: 'model', ref: 'model:', version: '1' }).success).toBe(
      false,
    );
    expect(
      ModelActorSchema.safeParse({ kind: 'model', ref: 'model:gpt-4o@', version: '1' }).success,
    ).toBe(false);
  });
});

describe('a timestamp always carries an explicit offset', () => {
  it('accepts a UTC timestamp', () => {
    expect(TimestampSchema.safeParse('2026-11-10T12:00:00.000Z').success).toBe(true);
  });

  it('accepts a non-Z offset timestamp', () => {
    // The offset is ACCEPTED: the same record can be produced on machines in
    // different time zones and a local offset is still unambiguous.
    expect(TimestampSchema.safeParse('2026-11-10T12:00:00.000+02:00').success).toBe(true);
    expect(TimestampSchema.safeParse('2026-11-10T12:00:00.000-05:30').success).toBe(true);
  });

  it('rejects a zone-less local time', () => {
    // A zone-less local time is NOT a point in time, so it is rejected.
    const result = TimestampSchema.safeParse('2026-11-10T12:00:00.000');

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.length).toBeGreaterThan(0);
  });

  it('rejects a zone-less local time inside an entity too', () => {
    const result = PredictionSchema.safeParse({
      ...VALID_PREDICTION,
      createdAt: '2026-11-10T12:00:00.000',
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('createdAt');
  });
});
