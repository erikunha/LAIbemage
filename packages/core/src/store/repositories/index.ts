/**
 * The store's repositories: one per aggregate (spec 002, US2 / task 3.2).
 *
 * Every repository validates its payload with the contracts schema before
 * writing and returns typed data (`z.infer` of the contract schemas).
 *
 * ## The rule that shapes this layer
 *
 * **No repository exposes an "update label" or an "update provenance"
 * method.** A label changes by inserting a NEW row; a correction links to
 * the row it replaces with `supersededBy` (see
 * {@link AnnotationsRepository.correctAnnotation}). The few update methods
 * that do exist (`experiments.updateStatus`, `deployments.setActive`,
 * `agentRuns.updateStatus`) touch lifecycle state only and never touch a
 * label, an actor, a surface or a timestamp of record.
 *
 * This is a constitutional invariant (constitution II), not a style choice:
 * the audit trail must be able to show what was said, when, by whom and on
 * which surface — forever.
 */

import type { SqliteDatabase } from '../db.js';
import { AgentRunsRepository } from './agent-runs.js';
import { AnnotationsRepository } from './annotations.js';
import { AssetsRepository } from './assets.js';
import { CaptureSessionsRepository } from './capture-sessions.js';
import { DerivedArtifactsRepository } from './derived-artifacts.js';
import { DeploymentsRepository } from './deployments.js';
import { EvaluationsRepository } from './evaluations.js';
import { ExperimentsRepository } from './experiments.js';
import { FeedbackRepository } from './feedback.js';
import { LabelViewRepository } from './label-view.js';
import { ModelsRepository } from './models.js';
import { OntologyRepository } from './ontology.js';
import { PredictionsRepository } from './predictions.js';
import { SamplesRepository } from './samples.js';
import { SnapshotsRepository } from './snapshots.js';

export { AgentRunsRepository } from './agent-runs.js';
export { AnnotationsRepository, assertSupersedeTarget } from './annotations.js';
export { AssetsRepository } from './assets.js';
export { CaptureSessionsRepository } from './capture-sessions.js';
export { DerivedArtifactsRepository } from './derived-artifacts.js';
export type { DerivedArtifactLinks } from './derived-artifacts.js';
export { DeploymentsRepository } from './deployments.js';
export { EvaluationsRepository } from './evaluations.js';
export { ExperimentsRepository } from './experiments.js';
export { FeedbackRepository } from './feedback.js';
export { LabelViewRepository } from './label-view.js';
export type { LabelViewFilter, LabelViewRow } from './label-view.js';
export { ModelsRepository } from './models.js';
export type { ModelVersionLinks } from './models.js';
export { OntologyRepository } from './ontology.js';
export { PredictionsRepository } from './predictions.js';
export { SamplesRepository } from './samples.js';
export { SnapshotsRepository } from './snapshots.js';
export {
  BaseRepository,
  NOT_RECORDED,
  boolToInt,
  intToBool,
  nullableNumber,
  nullableText,
  optionalText,
  parseEntity,
  sentinelText,
} from './base.js';
export type { JsonValue, Row } from './base.js';

/** Every repository of the store, bound to one database handle. */
export interface Repositories {
  readonly assets: AssetsRepository;
  readonly captureSessions: CaptureSessionsRepository;
  readonly samples: SamplesRepository;
  readonly ontology: OntologyRepository;
  readonly annotations: AnnotationsRepository;
  readonly predictions: PredictionsRepository;
  readonly snapshots: SnapshotsRepository;
  readonly experiments: ExperimentsRepository;
  readonly models: ModelsRepository;
  readonly evaluations: EvaluationsRepository;
  readonly deployments: DeploymentsRepository;
  readonly feedback: FeedbackRepository;
  readonly agentRuns: AgentRunsRepository;
  readonly derivedArtifacts: DerivedArtifactsRepository;
  readonly labelView: LabelViewRepository;
}

/** Builds every repository on top of one database handle. */
export function createRepositories(db: SqliteDatabase): Repositories {
  return {
    assets: new AssetsRepository(db),
    captureSessions: new CaptureSessionsRepository(db),
    samples: new SamplesRepository(db),
    ontology: new OntologyRepository(db),
    annotations: new AnnotationsRepository(db),
    predictions: new PredictionsRepository(db),
    snapshots: new SnapshotsRepository(db),
    experiments: new ExperimentsRepository(db),
    models: new ModelsRepository(db),
    evaluations: new EvaluationsRepository(db),
    deployments: new DeploymentsRepository(db),
    feedback: new FeedbackRepository(db),
    agentRuns: new AgentRunsRepository(db),
    derivedArtifacts: new DerivedArtifactsRepository(db),
    labelView: new LabelViewRepository(db),
  };
}
