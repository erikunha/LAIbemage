import { describe, expect, it } from 'vitest';
import { AnnotationSchema, PredictionSchema } from '../src/index.js';

/**
 * Cross-parse rejection (spec 002 US1 / FR-002, constitution II).
 *
 * The point of these tests is not that "something threw" — it is that a model
 * output can never be recorded as human ground truth, and that the failure
 * says WHICH invariant was violated.
 */

/** A valid UUIDv7 (version nibble `7`, variant nibble `8`). */
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
  actor: { kind: 'model', ref: 'model:alpha', version: '1.2.0' },
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

describe('Prediction rejects a human actor', () => {
  it('rejects actor.kind = "human"', () => {
    const result = PredictionSchema.safeParse({
      ...VALID_PREDICTION,
      actor: { kind: 'human', ref: 'user:erik' },
    });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    const actorIssue = issues.find((issue) => issue.path[0] === 'actor');
    expect(actorIssue).toBeDefined();
    expect(actorIssue?.message).toMatch(/discriminator/i);
    expect(actorIssue?.message).toContain('model');
  });

  it('rejects actor.kind = "agent"', () => {
    const result = PredictionSchema.safeParse({
      ...VALID_PREDICTION,
      actor: { kind: 'agent', ref: 'agent:investigator' },
    });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.some((issue) => issue.path[0] === 'actor')).toBe(true);
  });

  it('rejects a model actor whose ref breaks the model:<id> convention', () => {
    const result = PredictionSchema.safeParse({
      ...VALID_PREDICTION,
      actor: { kind: 'model', ref: 'user:erik', version: '1.2.0' },
    });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.some((issue) => issue.path.join('.') === 'actor.ref')).toBe(true);
  });

  it('accepts the constitutional `model:<id>@<version>` actor reference', () => {
    // Constitution II fixes the actor reference as `model:<id>@<version>`:
    // the contract MUST accept that form, not only the bare `model:<id>`.
    const result = PredictionSchema.safeParse({
      ...VALID_PREDICTION,
      actor: { kind: 'model', ref: 'model:gpt-4o@2024-01', version: '2024-01' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a model actor ref that carries whitespace', () => {
    const result = PredictionSchema.safeParse({
      ...VALID_PREDICTION,
      actor: { kind: 'model', ref: 'model:gpt 4o', version: '1.2.0' },
    });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    const refIssue = issues.find((issue) => issue.path.join('.') === 'actor.ref');
    expect(refIssue).toBeDefined();
    expect(refIssue?.message).toContain('model:<id>');
  });
});

describe('Prediction and Annotation do not cross-parse', () => {
  it('rejects a Prediction payload with the Annotation schema', () => {
    const result = AnnotationSchema.safeParse(VALID_PREDICTION);

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    const paths = issues.map((issue) => issue.path.join('.'));

    // `ontologyVersionId` is required by an Annotation and absent from a Prediction.
    expect(paths).toContain('ontologyVersionId');
    // The model actor is unknown to an Annotation (its actor union is
    // human/agent only), so the actor path carries an issue too.
    expect(paths.some((path) => path.startsWith('actor'))).toBe(true);

    // The strictness check: `modelVersionId` is unknown to an Annotation.
    const unrecognized = issues.find(
      (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('modelVersionId'),
    );
    expect(unrecognized).toBeDefined();
    expect(unrecognized?.message).toContain('modelVersionId');
  });

  it('rejects an Annotation payload with the Prediction schema', () => {
    const result = PredictionSchema.safeParse(VALID_ANNOTATION);

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    const paths = issues.map((issue) => issue.path.join('.'));

    // `modelVersionId` is required by a Prediction and absent from an Annotation.
    expect(paths).toContain('modelVersionId');
    // The human actor is unknown to a Prediction (its actor union is model
    // only), so the actor path carries an issue too.
    expect(paths.some((path) => path.startsWith('actor'))).toBe(true);

    // The strictness check: `ontologyVersionId` is unknown to a Prediction.
    const unrecognized = issues.find(
      (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('ontologyVersionId'),
    );
    expect(unrecognized).toBeDefined();
    expect(unrecognized?.message).toContain('ontologyVersionId');
  });

  it('accepts each payload with its own schema', () => {
    expect(PredictionSchema.safeParse(VALID_PREDICTION).success).toBe(true);
    expect(AnnotationSchema.safeParse(VALID_ANNOTATION).success).toBe(true);
  });
});
