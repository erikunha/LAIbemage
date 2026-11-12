import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WorkerErrorFrameSchema,
  WorkerEventFrameSchema,
  WorkerProgressFrameSchema,
  WorkerRequestFrameSchema,
  WorkerResultFrameSchema,
} from '../../src/index.js';

/**
 * Task 2.1: the golden payloads of the worker protocol, seeded from the
 * pack examples and extended.
 *
 * `request` and `progress` are the pack examples VERBATIM; `result` is the
 * pack example minus the proposal-only top-level `status` field (the
 * decided option B, spec 018 FR-005 note: the ratified result envelope omits
 * `status` and the strict schema rejects it); `error` has no pack example
 * and is authored here, carrying a transient code so the retryable flag is
 * pinned true next to it.
 *
 * Each fixture is loaded from disk (never inlined only), pinned to a literal
 * so an accidental edit fails here, and safeParsed against its schema so
 * the golden set can never drift from the ratified contract.
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/worker/', import.meta.url));
const EXAMPLES_DIR = fileURLToPath(
  new URL('../../../../docs/vnext/contracts/proposed/examples/', import.meta.url),
);

const loadJson = (dir: string, name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;

describe('golden fixture: request.golden.json', () => {
  const golden = loadJson(FIXTURES_DIR, 'request.golden.json');

  it('is exactly the pack request example, seeded verbatim', () => {
    expect(golden).toEqual(loadJson(EXAMPLES_DIR, 'worker-request.example.json'));
  });

  it('validates against the ratified request schema', () => {
    const result = WorkerRequestFrameSchema.safeParse(golden);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(golden);
      expect(result.data.budget.maxTokens).toBe(0);
    }
  });

  it('rejects the seeded payload with a required field removed', () => {
    const withoutBudget = { ...golden } as Partial<typeof golden>;
    delete withoutBudget['budget'];
    expect(WorkerRequestFrameSchema.safeParse(withoutBudget).success).toBe(false);
  });

  it('rejects the seeded payload with an unknown field added', () => {
    expect(WorkerRequestFrameSchema.safeParse({ ...golden, assetPath: '/tmp/x.png' }).success).toBe(
      false,
    );
  });
});

describe('golden fixture: progress.golden.json', () => {
  const golden = loadJson(FIXTURES_DIR, 'progress.golden.json');

  it('is exactly the pack progress example, seeded verbatim', () => {
    expect(golden).toEqual(loadJson(EXAMPLES_DIR, 'worker-progress.example.json'));
  });

  it('validates against the ratified event schema as a progress frame', () => {
    const result = WorkerEventFrameSchema.safeParse(golden);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(golden);
    }
    expect(WorkerProgressFrameSchema.safeParse(golden).success).toBe(true);
  });

  it('rejects completed above total (the extension case)', () => {
    const overflow = { ...golden, completed: 6, total: 5 };
    expect(WorkerProgressFrameSchema.safeParse(overflow).success).toBe(false);
  });
});

describe('golden fixture: result.golden.json', () => {
  const golden = loadJson(FIXTURES_DIR, 'result.golden.json');

  it('is the pack result example with exactly the proposal-only status field set aside', () => {
    const packExample = loadJson(EXAMPLES_DIR, 'worker-result.example.json');
    const { status, ...withoutStatus } = packExample;
    expect(status).toBe('succeeded');
    expect(golden).toEqual(withoutStatus);
  });

  it('validates against the ratified result schema, artifact digest intact', () => {
    const result = WorkerResultFrameSchema.safeParse(golden);
    expect(result.success).toBe(true);
    if (result.success) {
      const payload = result.data.result as { artifactSha256?: string };
      expect(payload.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.data.seq).toBe(1);
    }
  });

  it('rejects the golden payload with the pack status field reintroduced', () => {
    expect(WorkerResultFrameSchema.safeParse({ ...golden, status: 'succeeded' }).success).toBe(
      false,
    );
  });
});

describe('golden fixture: error.golden.json', () => {
  const golden = loadJson(FIXTURES_DIR, 'error.golden.json');

  it('validates against the ratified error schema with a transient code', () => {
    const result = WorkerErrorFrameSchema.safeParse(golden);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('PROVIDER_UNAVAILABLE');
      expect(result.data.retryable).toBe(true);
    }
  });

  it('rejects an unknown error code and a non-boolean retryable flag', () => {
    expect(WorkerErrorFrameSchema.safeParse({ ...golden, code: 'NOPE' }).success).toBe(false);
    expect(WorkerErrorFrameSchema.safeParse({ ...golden, retryable: 'yes' }).success).toBe(false);
  });

  it('still validates when requestId and seq are absent (an unrecoverable line)', () => {
    const channelLevel = { ...golden } as Partial<typeof golden>;
    delete channelLevel['requestId'];
    delete channelLevel['seq'];
    const result = WorkerErrorFrameSchema.safeParse(channelLevel);
    expect(result.success).toBe(true);
  });
});
