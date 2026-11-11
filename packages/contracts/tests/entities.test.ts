import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentRunSchema,
  AnnotationSchema,
  AssetSchema,
  CalibrationSchema,
  CaptureSessionSchema,
  DatasetSnapshotSchema,
  DeploymentSchema,
  DerivedArtifactSchema,
  EvaluationRunSchema,
  ExperimentRunSchema,
  FeedbackEventSchema,
  FrameSchema,
  ModelVersionSchema,
  OntologyVersionSchema,
  PredictionSchema,
  SampleSchema,
  SynchronizedSequenceSchema,
  TrackSchema,
} from '../src/index.js';
import {
  PROPERTY_RUNS,
  PROPERTY_SEED,
  agentRunArb,
  annotationArb,
  assetArb,
  captureSessionArb,
  datasetSnapshotArb,
  deploymentArb,
  derivedArtifactArb,
  evaluationRunArb,
  experimentRunArb,
  feedbackEventArb,
  modelVersionArb,
  ontologyVersionArb,
  predictionArb,
  sampleArb,
} from './arbitraries.js';

/**
 * Round-trip property tests for every entity of the domain model (spec 002
 * SC-001).
 *
 * Each case generates a VALID instance, parses it and re-parses the output:
 * a schema that is not idempotent under `parse(parse(x))` would break every
 * consumer that stores and reloads a record.
 *
 * Determinism: fixed seed 20261110 and 100 runs per entity (see
 * `arbitraries.ts`), so a failure reproduces exactly in CI.
 */

const ENTITY_CASES: Array<{
  name: string;
  schema: z.ZodType;
  arbitrary: fc.Arbitrary<Record<string, unknown>>;
}> = [
  { name: 'Asset', schema: AssetSchema, arbitrary: assetArb },
  { name: 'CaptureSession', schema: CaptureSessionSchema, arbitrary: captureSessionArb },
  { name: 'Sample', schema: SampleSchema, arbitrary: sampleArb },
  { name: 'OntologyVersion', schema: OntologyVersionSchema, arbitrary: ontologyVersionArb },
  { name: 'Annotation', schema: AnnotationSchema, arbitrary: annotationArb },
  { name: 'Prediction', schema: PredictionSchema, arbitrary: predictionArb },
  { name: 'DatasetSnapshot', schema: DatasetSnapshotSchema, arbitrary: datasetSnapshotArb },
  { name: 'ExperimentRun', schema: ExperimentRunSchema, arbitrary: experimentRunArb },
  { name: 'ModelVersion', schema: ModelVersionSchema, arbitrary: modelVersionArb },
  { name: 'EvaluationRun', schema: EvaluationRunSchema, arbitrary: evaluationRunArb },
  { name: 'Deployment', schema: DeploymentSchema, arbitrary: deploymentArb },
  { name: 'FeedbackEvent', schema: FeedbackEventSchema, arbitrary: feedbackEventArb },
  { name: 'AgentRun', schema: AgentRunSchema, arbitrary: agentRunArb },
  { name: 'DerivedArtifact', schema: DerivedArtifactSchema, arbitrary: derivedArtifactArb },
];

describe('entity round-trip (property)', () => {
  describe.each(ENTITY_CASES)('$name', ({ schema, arbitrary }) => {
    it('parses a generated instance and re-parses its own output unchanged', () => {
      fc.assert(
        fc.property(arbitrary, (value) => {
          const parsed = schema.parse(value);
          expect(schema.parse(parsed)).toEqual(parsed);
        }),
        { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
      );
    });
  });

  const RESERVED_CASES = [
    { name: 'Track', schema: TrackSchema, entity: 'track' },
    { name: 'Frame', schema: FrameSchema, entity: 'frame' },
    { name: 'Calibration', schema: CalibrationSchema, entity: 'calibration' },
    {
      name: 'SynchronizedSequence',
      schema: SynchronizedSequenceSchema,
      entity: 'synchronized-sequence',
    },
  ];

  describe.each(RESERVED_CASES)('reserved $name', ({ schema, entity }) => {
    it('round-trips its minimal reserved shape', () => {
      fc.assert(
        fc.property(fc.constant({ reserved: true, entity }), (value) => {
          const parsed = schema.parse(value);
          expect(schema.parse(parsed)).toEqual(parsed);
        }),
        { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
      );
    });
  });
});

describe('entity schemas reject unknown keys', () => {
  it.each(ENTITY_CASES)('$name rejects an unknown key', ({ schema, arbitrary }) => {
    fc.assert(
      fc.property(arbitrary, (value) => {
        const polluted = { ...value, definitelyNotAField: 'x' };
        const result = schema.safeParse(polluted);
        expect(result.success).toBe(false);
        const issues = result.success ? [] : result.error.issues;
        const unrecognized = issues.filter((issue) => issue.code === 'unrecognized_keys');
        expect(unrecognized.length).toBeGreaterThan(0);
        expect(unrecognized[0].message).toContain('definitelyNotAField');
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });
});
