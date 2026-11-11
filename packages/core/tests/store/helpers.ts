import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentRun,
  Annotation,
  Asset,
  CaptureSession,
  DatasetSnapshot,
  Deployment,
  DerivedArtifact,
  EvaluationRun,
  ExperimentRun,
  FeedbackEvent,
  ModelVersion,
  OntologyVersion,
  Prediction,
  Sample,
} from '@master-vision/contracts';
import {
  applyMigrations,
  createRepositories,
  newEntityId,
  openStore,
  type Repositories,
  type SqliteDatabase,
} from '../../src/store/index.js';

/**
 * Test helpers for the store suite.
 *
 * EVERY test uses an explicit temporary directory (`fs.mkdtemp`) and cleans
 * it up. The user's home directory is never touched — not even by the test
 * that exercises `defaultStorePath()`.
 */

/** A migrated store on a temporary path, with its repositories. */
export interface TestStore {
  readonly dir: string;
  readonly dbPath: string;
  readonly db: SqliteDatabase;
  readonly repos: Repositories;
  cleanup(): void;
}

/** Creates a temporary directory that the caller must remove. */
export function makeTempDir(prefix = 'mv-store-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Removes a temporary directory. */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Opens a store on a fresh temporary path and migrates it. */
export async function createTestStore(): Promise<TestStore> {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'store.db');
  const store = await openStore(dbPath);
  applyMigrations(store.db);
  return {
    dir,
    dbPath,
    db: store.db,
    repos: createRepositories(store.db),
    cleanup(): void {
      store.close();
      removeTempDir(dir);
    },
  };
}

/** A timestamp in the past, so `updated_at` bumps are observable. */
export const OLD_TIMESTAMP = '2024-01-01T00:00:00.000Z';

/** A 64-hex sha256 for fixtures. */
export const FAKE_SHA256 = 'a'.repeat(64);

/** A 64-hex sha256 for a second fixture. */
export const OTHER_SHA256 = 'b'.repeat(64);

/** An asset fixture. */
export function assetFixture(overrides: Partial<Asset> = {}): Asset {
  return {
    id: newEntityId(),
    sha256: FAKE_SHA256,
    kind: 'image',
    bytes: 1024,
    width: 800,
    height: 600,
    unhashed: false,
    path: '/tmp/asset.jpg',
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** A capture session fixture. */
export function captureSessionFixture(overrides: Partial<CaptureSession> = {}): CaptureSession {
  return {
    id: newEntityId(),
    startedAt: OLD_TIMESTAMP,
    source: 'line-a/cam-03',
    ...overrides,
  };
}

/** A sample fixture. */
export function sampleFixture(overrides: Partial<Sample> = {}): Sample {
  const base: Sample = {
    id: newEntityId(),
    assetId: newEntityId(),
    snapshotIds: [],
    createdAt: OLD_TIMESTAMP,
  };
  return { ...base, ...overrides, snapshotIds: overrides.snapshotIds ?? base.snapshotIds };
}

/** An ontology version fixture. */
export function ontologyFixture(overrides: Partial<OntologyVersion> = {}): OntologyVersion {
  return {
    id: newEntityId(),
    version: '1.0.0',
    categories: [{ key: 'kitchen', name: 'kitchen', description: 'Kitchen area' }],
    fingerprint: 'fp2:0123456789abcdef',
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** An annotation fixture (human actor). */
export function annotationFixture(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: newEntityId(),
    sampleId: newEntityId(),
    ontologyVersionId: newEntityId(),
    labelKey: 'kitchen',
    actor: { kind: 'human', ref: 'user:erik', displayName: 'Erik' },
    surface: 'studio',
    sessionId: 'session-1',
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** A prediction fixture (model actor). */
export function predictionFixture(overrides: Partial<Prediction> = {}): Prediction {
  return {
    id: newEntityId(),
    sampleId: newEntityId(),
    modelVersionId: newEntityId(),
    labelKey: 'kitchen',
    probabilityRaw: 0.8,
    actor: { kind: 'model', ref: 'model:gpt-4o', version: '2024-05-13' },
    surface: 'cli',
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** A dataset snapshot fixture. */
export function snapshotFixture(overrides: Partial<DatasetSnapshot> = {}): DatasetSnapshot {
  return {
    id: newEntityId(),
    manifestHash: FAKE_SHA256,
    splitAssignments: OTHER_SHA256,
    ontologyVersionId: newEntityId(),
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** An experiment run fixture. */
export function experimentFixture(overrides: Partial<ExperimentRun> = {}): ExperimentRun {
  return {
    id: newEntityId(),
    kind: 'classify',
    configFingerprint: 'fp2:0123456789abcdef',
    status: 'queued',
    startedAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** A model version fixture. */
export function modelVersionFixture(overrides: Partial<ModelVersion> = {}): ModelVersion {
  return {
    id: newEntityId(),
    name: 'gpt-4o',
    version: '2024-05-13',
    registryState: 'registered',
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** An evaluation run fixture. */
export function evaluationFixture(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: newEntityId(),
    experimentRunId: newEntityId(),
    protocol: 'holdout-v1',
    resultsJson: { macroF1: 0.82 },
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** A deployment fixture. */
export function deploymentFixture(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: newEntityId(),
    modelVersionId: newEntityId(),
    target: 'local',
    configJson: { temperature: 0 },
    active: false,
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** A feedback event fixture. */
export function feedbackFixture(overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return {
    id: newEntityId(),
    sampleId: newEntityId(),
    kind: 'flag',
    payloadJson: { reason: 'blurry' },
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** An agent run fixture. */
export function agentRunFixture(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: newEntityId(),
    goal: 'find the leaking pipe',
    status: 'running',
    budgetJson: { maxCalls: 10 },
    toolCalls: [],
    approvals: [],
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}

/** A derived artifact fixture. */
export function derivedArtifactFixture(overrides: Partial<DerivedArtifact> = {}): DerivedArtifact {
  return {
    id: newEntityId(),
    kind: 'embedding',
    sourceAssetIds: [newEntityId()],
    transform: 'embedding:openai/text-embedding-3-small',
    transformFingerprint: 'fp2:0123456789abcdef',
    createdAt: OLD_TIMESTAMP,
    ...overrides,
  };
}
