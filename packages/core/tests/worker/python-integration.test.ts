import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  WORKER_OPERATIONS,
  WORKER_PROTOCOL_ID,
  type WorkerOperation,
  type WorkerProgressFrame,
} from '@vision-lens/contracts';
import {
  WorkerClient,
  WORKER_INTERPRETER_ENV,
  type WorkerClientOptions,
  type WorkerRequestInput,
} from '../../src/worker/index.js';
import { teardown, TEST_BUDGET, track, until } from './helpers.js';

/**
 * The cross-language integration suite: the real TypeScript host client
 * against the real Python worker over the frozen visionlens.worker.v1 wire.
 *
 * Every test spawns python/visionlens/src/visionlens/worker.py as an actual
 * subprocess and asserts observable wire behaviour only: hello, progress,
 * result and error frames, never Python source text. The whole suite skips
 * when python3 is unavailable or the worker entry is not resolvable from the
 * repository root.
 */
vi.setConfig({ testTimeout: 15_000 });

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PYTHON_SRC = path.join(REPO_ROOT, 'python', 'visionlens', 'src');
const WORKER_ENTRY = path.join(PYTHON_SRC, 'visionlens', 'worker.py');

const PYTHON_INTERPRETER = 'python3';
const PYTHON_AVAILABLE =
  spawnSync(PYTHON_INTERPRETER, ['--version'], { encoding: 'utf8' }).status === 0;
const WORKER_RESOLVED = existsSync(WORKER_ENTRY);

/**
 * A model id the Python registry serves: the siglip2-base entry of
 * DEFAULT_MODELS in python/visionlens/src/visionlens/registry/simulated.py, revision
 * r2026-03-01, dimension 768, cpu only, no required extra.
 */
const EMBED_MODEL = 'siglip2-base';
const EMBED_DIMENSION = 768;
const WORKSPACE_ID = 'ws-python-integration';

// Two tiny synthetic images: a PNG signature plus fixed bytes, base64
// encoded. The worker embeds each reference opaquely, so any deterministic
// bytes serve; these two differ so their vectors must differ too.
const IMAGES = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString(
    'base64',
  ),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0a]).toString(
    'base64',
  ),
];

/** The frozen vision.embed result payload, field by field. */
interface EmbedResult {
  model: string;
  dimension: number;
  dtype: string;
  count: number;
  vectors: number[][];
  artifactSha256: string;
  preprocessingFingerprint: string;
  device: string;
  fallbackReason?: string;
}

afterEach(async () => {
  await teardown();
});

/** The child environment; the PYTHONPATH form mirrors the Python test helpers. */
function pythonWorkerEnv(): NodeJS.ProcessEnv {
  const existing = process.env.PYTHONPATH;
  return {
    PYTHONPATH: existing ? PYTHON_SRC + path.delimiter + existing : PYTHON_SRC,
  };
}

/**
 * Launches the real Python worker and registers it for teardown.
 *
 * worker.py is a package module, not a standalone script: `python3 worker.py`
 * dies on its package-relative imports, so no single script path, and no
 * VISION_LENS_WORKER_SCRIPT value, can start it. The client composes the
 * child argv as [scriptPath, ...scriptArgs], so a scriptPath of '-m' plus
 * the module name yields `python3 -m visionlens.worker`, the entrypoint the
 * worker's own docstring and the Python subprocess tests use. No bridge
 * script, no inline -c.
 */
async function launchRealWorker(options: Partial<WorkerClientOptions> = {}): Promise<WorkerClient> {
  const client = await WorkerClient.launch({
    scriptPath: '-m',
    scriptArgs: ['visionlens.worker'],
    env: pythonWorkerEnv(),
    ...options,
  });
  return track(client);
}

/** A well-formed vision.embed request for the synthetic images. */
function embedInput(requestId: string): WorkerRequestInput {
  return {
    requestId,
    operation: 'vision.embed',
    workspaceId: WORKSPACE_ID,
    params: { images: IMAGES, model: EMBED_MODEL },
    budget: { ...TEST_BUDGET },
  };
}

describe.skipIf(!PYTHON_AVAILABLE || !WORKER_RESOLVED)('python worker integration', () => {
  let previousInterpreter: string | undefined;

  beforeAll(() => {
    // The interpreter reaches the client through the environment variable it
    // reads; the entry itself cannot (see launchRealWorker).
    previousInterpreter = process.env[WORKER_INTERPRETER_ENV];
    process.env[WORKER_INTERPRETER_ENV] = PYTHON_INTERPRETER;
  });

  afterAll(() => {
    if (previousInterpreter === undefined) delete process.env[WORKER_INTERPRETER_ENV];
    else process.env[WORKER_INTERPRETER_ENV] = previousInterpreter;
  });

  it('receives the unprompted hello with the exact protocol id, the five frozen operations and the cpu device', async () => {
    const client = await launchRealWorker();

    expect(client.clientState).toBe('running');
    expect(client.hello.protocol).toBe(WORKER_PROTOCOL_ID);
    expect([...client.hello.supportedOperations].sort()).toEqual([...WORKER_OPERATIONS].sort());
    expect(client.hello.capabilities.device).toBe('cpu');
  });

  it('vision.embed returns the frozen result shape field by field for two synthetic images', async () => {
    const client = await launchRealWorker();
    const progressFrames: WorkerProgressFrame[] = [];

    const outcome = await client.request({
      ...embedInput('r-embed-shape'),
      onProgress: (frame) => progressFrames.push(frame),
    });

    expect(outcome.requestId).toBe('r-embed-shape');
    const result = outcome.result as EmbedResult;
    expect(result.model).toBe(EMBED_MODEL);
    expect(result.dimension).toBe(EMBED_DIMENSION);
    expect(result.dtype).toBe('float32');
    expect(result.count).toBe(IMAGES.length);
    expect(result.vectors).toHaveLength(IMAGES.length);
    for (const vector of result.vectors) {
      expect(vector).toHaveLength(EMBED_DIMENSION);
    }
    // The simulated encoder emits components in [-1, 1], and distinct images
    // embed to distinct vectors.
    const inRange = result.vectors.every((vector) =>
      vector.every((value) => value >= -1 && value <= 1),
    );
    expect(inRange).toBe(true);
    expect(result.vectors[0]).not.toEqual(result.vectors[1]);
    expect(result.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.preprocessingFingerprint).toMatch(/^fp2:[0-9a-f]{16}$/);
    expect(result.device).toBe('cpu');
    expect(result.fallbackReason).toBeUndefined();

    // The frozen sequence rules held on the wire: progress started at seq 0,
    // strictly increased, never overran its total, and the terminal frame
    // carried the highest seq of the request.
    const seqs = progressFrames.map((frame) => frame.seq);
    expect(seqs[0]).toBe(0);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBeGreaterThan(seqs[index - 1]);
    }
    const wellFormedProgress = progressFrames.every(
      (frame) => frame.requestId === 'r-embed-shape' && frame.completed <= frame.total,
    );
    expect(wellFormedProgress).toBe(true);
    expect(outcome.seq).toBeGreaterThan(seqs[seqs.length - 1]);
  });

  it('a second spawn embeds the same images to identical vectors and digests', async () => {
    const first = await launchRealWorker();
    const second = await launchRealWorker();

    const [fromFirst, fromSecond] = await Promise.all([
      first.request(embedInput('r-determinism-a')),
      second.request(embedInput('r-determinism-b')),
    ]);
    const firstResult = fromFirst.result as EmbedResult;
    const secondResult = fromSecond.result as EmbedResult;

    expect(secondResult.vectors).toEqual(firstResult.vectors);
    expect(secondResult.artifactSha256).toBe(firstResult.artifactSha256);
    expect(secondResult.preprocessingFingerprint).toBe(firstResult.preprocessingFingerprint);
    expect(secondResult.dimension).toBe(firstResult.dimension);
  });

  it('cancelling a slow model.train mid-operation settles as CANCELLED, never as a result', async () => {
    const client = await launchRealWorker();
    const progressFrames: WorkerProgressFrame[] = [];

    const request = client.request({
      requestId: 'r-train-cancel',
      operation: 'model.train',
      workspaceId: WORKSPACE_ID,
      // The slow recipe loops 100 steps with a 0.05 s sleep each, so the
      // operation is still running when the cancel lands.
      params: { dataset: 'synthetic-dataset', recipe: 'slow' },
      budget: { ...TEST_BUDGET },
      onProgress: (frame) => progressFrames.push(frame),
    });
    const settled = request.then(
      () => null,
      (error: unknown) => error,
    );

    await until(() => progressFrames.length > 0);
    const outcome = await client.cancel('r-train-cancel');

    expect(outcome).toBe('acknowledged');
    const failure = await settled;
    expect(failure).toMatchObject({
      name: 'WorkerProtocolError',
      code: 'CANCELLED',
      retryable: false,
    });
    // An acknowledged cancel leaves the worker serving.
    expect(client.clientState).toBe('running');
  });

  it('an operation outside the frozen five is refused as UNSUPPORTED_OPERATION', async () => {
    const client = await launchRealWorker();

    // A well-formed code outside the frozen five is not a WorkerOperation;
    // the widening only crosses the boundary the client validates against
    // the worker's own advertisement.
    const operation = 'vision.noop' as unknown as WorkerOperation;
    await expect(
      client.request({
        operation,
        workspaceId: WORKSPACE_ID,
        params: {},
        budget: { ...TEST_BUDGET },
      }),
    ).rejects.toMatchObject({
      name: 'WorkerProtocolError',
      code: 'UNSUPPORTED_OPERATION',
      retryable: false,
    });

    // The refusal happened on the host, against the advertisement the real
    // worker sent; the channel is untouched.
    expect(client.clientState).toBe('running');
  });
});
