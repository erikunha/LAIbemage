/**
 * The 14 entities of the Vision Lens domain model (spec 002) plus the four
 * reserved stubs.
 *
 * `ENTITY_SCHEMAS` is the registry consumed by the contract manifest
 * generator (`../manifest.ts`) and, later, by the OpenAPI seed (spec 002
 * task 1.5). The reserved stubs are kept OUT of it on purpose: they are
 * declared names, not entities of the current model.
 */

export { AgentRunSchema, ApprovalSchema, ToolCallSchema } from './agent-run.js';
export type { AgentRun, Approval, ToolCall } from './agent-run.js';

export { AnnotationSchema } from './annotation.js';
export type { Annotation } from './annotation.js';

export { AssetSchema } from './asset.js';
export type { Asset } from './asset.js';

export { CaptureSessionSchema } from './capture-session.js';
export type { CaptureSession } from './capture-session.js';

export { DeploymentSchema } from './deployment.js';
export type { Deployment } from './deployment.js';

export { DERIVED_ARTIFACT_KINDS, DerivedArtifactSchema } from './derived-artifact.js';
export type { DerivedArtifact, DerivedArtifactKind } from './derived-artifact.js';

export { EvaluationRunSchema } from './evaluation.js';
export type { EvaluationRun } from './evaluation.js';

export { ExperimentRunSchema } from './experiment.js';
export type { ExperimentRun } from './experiment.js';

export { FeedbackEventSchema } from './feedback.js';
export type { FeedbackEvent } from './feedback.js';

export { ModelVersionSchema } from './model-version.js';
export type { ModelVersion } from './model-version.js';

export { OntologyCategorySchema, OntologyVersionSchema } from './ontology.js';
export type { OntologyCategory, OntologyVersion } from './ontology.js';

export { PredictionSchema } from './prediction.js';
export type { Prediction } from './prediction.js';

export {
  RESERVED_ENTITIES,
  RESERVED_ENTITY_MESSAGE,
  RESERVED_SCHEMAS,
  CalibrationSchema,
  FrameSchema,
  SynchronizedSequenceSchema,
  TrackSchema,
} from './reserved.js';
export type { ReservedEntity, ReservedSchemaName } from './reserved.js';

export { SampleSchema } from './sample.js';
export type { Sample } from './sample.js';

export { DatasetSnapshotSchema } from './snapshot.js';
export type { DatasetSnapshot } from './snapshot.js';

import { AgentRunSchema } from './agent-run.js';
import { AnnotationSchema } from './annotation.js';
import { AssetSchema } from './asset.js';
import { CaptureSessionSchema } from './capture-session.js';
import { DeploymentSchema } from './deployment.js';
import { DerivedArtifactSchema } from './derived-artifact.js';
import { EvaluationRunSchema } from './evaluation.js';
import { ExperimentRunSchema } from './experiment.js';
import { FeedbackEventSchema } from './feedback.js';
import { ModelVersionSchema } from './model-version.js';
import { OntologyVersionSchema } from './ontology.js';
import { PredictionSchema } from './prediction.js';
import { SampleSchema } from './sample.js';
import { DatasetSnapshotSchema } from './snapshot.js';

/**
 * Every entity of the domain model, keyed by its public name.
 *
 * The insertion order is the documented reference order used by the contract
 * manifest and the entity reference table in `docs/architecture/domain-model.md`.
 */
export const ENTITY_SCHEMAS = {
  Asset: AssetSchema,
  CaptureSession: CaptureSessionSchema,
  Sample: SampleSchema,
  OntologyVersion: OntologyVersionSchema,
  Annotation: AnnotationSchema,
  Prediction: PredictionSchema,
  DatasetSnapshot: DatasetSnapshotSchema,
  ExperimentRun: ExperimentRunSchema,
  ModelVersion: ModelVersionSchema,
  EvaluationRun: EvaluationRunSchema,
  Deployment: DeploymentSchema,
  FeedbackEvent: FeedbackEventSchema,
  AgentRun: AgentRunSchema,
  DerivedArtifact: DerivedArtifactSchema,
} as const;

export type EntityName = keyof typeof ENTITY_SCHEMAS;
