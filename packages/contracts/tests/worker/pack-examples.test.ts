import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WorkerEventFrameSchema,
  WorkerProgressFrameSchema,
  WorkerRequestFrameSchema,
  WorkerResultFrameSchema,
} from '../../src/index.js';

/**
 * Spec 018 SC-006: the three pack example payloads meet the RATIFIED
 * `visionlens.worker.v1` schemas, unchanged, on the TypeScript side.
 *
 * The pack under `docs/vnext/contracts/proposed/` is read-only input. Each
 * example is loaded from disk at run time (the repo root is resolved from
 * this file's URL, never hardcoded) and safeParsed against the live schema
 * the file represents: the request example against the request frame schema,
 * the progress and result examples against the event schema. Each payload is
 * also pinned to an inline literal, so any edit to a pack file fails here,
 * and the parse output is compared to the same literal, so a schema drift
 * that transforms, defaults or reshapes a field fails here too.
 *
 * One drift is pinned, not hidden. The pack's result example carries a
 * top-level `status: "succeeded"` that the pack proposal and spec 018 FR-005
 * require, but the ratified result envelope omits, so the strict event schema
 * rejects that payload today with exactly one unrecognized-key issue. The
 * last block asserts that exact outcome, and that setting `status` aside
 * yields a valid ratified result frame; the day the schema adopts `status`
 * (or the pack example is regenerated without it) those assertions flip and
 * force a conscious decision.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const EXAMPLES_DIR = join(
  REPO_ROOT,
  'docs',
  'vnext',
  'contracts',
  'proposed',
  'examples',
);

const loadExample = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(EXAMPLES_DIR, name), 'utf8')) as Record<string, unknown>;

/** The frozen request payload, pinned so a pack edit cannot pass silently. */
const REQUEST_EXAMPLE = {
  protocol: 'visionlens.worker.v1',
  kind: 'request',
  requestId: 'req_demo_001',
  operation: 'vision.embed',
  contractVersion: '1.0.0',
  workspaceId: 'local',
  params: {
    snapshotId: 'snap_demo_001',
    encoder: 'siglip2-base',
    assetsRef: 'assetset_demo_001',
  },
  budget: { maxSeconds: 120, maxUsdMicro: 0, maxTokens: 0 },
} as const;

/** The frozen progress payload, pinned the same way. */
const PROGRESS_EXAMPLE = {
  protocol: 'visionlens.worker.v1',
  kind: 'progress',
  requestId: 'req_demo_001',
  seq: 0,
  completed: 2,
  total: 5,
} as const;

/** The frozen result payload, pinned the same way, drift field included. */
const RESULT_EXAMPLE = {
  protocol: 'visionlens.worker.v1',
  kind: 'result',
  requestId: 'req_demo_001',
  seq: 1,
  status: 'succeeded',
  result: {
    embeddingRunId: 'embed_demo_001',
    count: 5,
    dimensions: 768,
    dtype: 'float32',
    artifactSha256: '0'.repeat(64),
    source: 'synthetic-example-not-a-real-run',
  },
} as const;

describe('pack example: worker-request.example.json', () => {
  const payload = loadExample('worker-request.example.json');

  it('is exactly the frozen pack payload', () => {
    expect(payload).toEqual(REQUEST_EXAMPLE);
  });

  it('validates unchanged against the ratified request schema', () => {
    const result = WorkerRequestFrameSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(REQUEST_EXAMPLE);
      expect(result.data.kind).toBe('request');
      expect(result.data.operation).toBe('vision.embed');
    }
  });
});

describe('pack example: worker-progress.example.json', () => {
  const payload = loadExample('worker-progress.example.json');

  it('is exactly the frozen pack payload', () => {
    expect(payload).toEqual(PROGRESS_EXAMPLE);
  });

  it('validates unchanged against the ratified event schema as a progress frame', () => {
    const result = WorkerEventFrameSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(PROGRESS_EXAMPLE);
      expect(result.data.kind).toBe('progress');
    }
  });

  it('also validates against the dedicated progress schema', () => {
    const result = WorkerProgressFrameSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(PROGRESS_EXAMPLE);
    }
  });
});

describe('pack example: worker-result.example.json', () => {
  const payload = loadExample('worker-result.example.json');

  it('is exactly the frozen pack payload', () => {
    expect(payload).toEqual(RESULT_EXAMPLE);
  });

  it('is rejected by the ratified event schema solely for the proposal-only status field', () => {
    const result = WorkerEventFrameSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      const issue = result.error.issues[0];
      expect(issue?.code).toBe('unrecognized_keys');
      expect(issue?.keys).toEqual(['status']);
    }
  });

  it('is a valid ratified result frame once the status field is set aside', () => {
    const { status: proposalOnlyStatus, ...withoutStatus } = RESULT_EXAMPLE;
    expect(proposalOnlyStatus).toBe('succeeded');
    const result = WorkerResultFrameSchema.safeParse(withoutStatus);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(withoutStatus);
      expect(result.data.kind).toBe('result');
      expect(result.data.requestId).toBe('req_demo_001');
      expect(result.data.seq).toBe(1);
    }
  });
});
