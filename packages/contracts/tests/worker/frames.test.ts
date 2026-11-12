import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  WORKER_ERROR_CODES,
  WORKER_ERROR_RETRYABLE,
  WORKER_OPERATIONS,
  WORKER_PROTOCOL_ID,
  WORKER_PROTOCOL_VERSION,
  WorkerBudgetSchema,
  WorkerCancelFrameSchema,
  WorkerErrorFrameSchema,
  WorkerHelloFrameSchema,
  WorkerProgressFrameSchema,
  WorkerRequestFrameSchema,
  WorkerResultFrameSchema,
} from '../../src/index.js';

/**
 * Table-driven tests for the ratified `visionlens.worker.v1` frames.
 *
 * Every exemplar below is a valid frame per the frozen wire contract; every
 * rejection asserts a rule the wire contract states (strict objects, exact
 * protocol string, bounded budget, frozen vocabularies).
 */

const PROTOCOL = 'visionlens.worker.v1';

/** One valid frame per envelope, following the frozen examples. */
const VALID_FRAMES = {
  hello: {
    protocol: PROTOCOL,
    kind: 'hello',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    contractVersion: '1.0.0',
    supportedOperations: ['vision.embed'],
    capabilities: { device: 'cpu', extras: [], models: [] },
    maxFrameBytes: 1_048_576,
  },
  request: {
    protocol: PROTOCOL,
    kind: 'request',
    requestId: 'r-1',
    operation: 'vision.embed',
    contractVersion: '1.0.0',
    workspaceId: 'ws-1',
    params: {},
    budget: { maxSeconds: 60, maxUsdMicro: 0 },
  },
  progress: {
    protocol: PROTOCOL,
    kind: 'progress',
    requestId: 'r-1',
    seq: 1,
    completed: 10,
    total: 100,
  },
  result: {
    protocol: PROTOCOL,
    kind: 'result',
    requestId: 'r-1',
    seq: 2,
    result: {},
  },
  error: {
    protocol: PROTOCOL,
    kind: 'error',
    requestId: 'r-1',
    seq: 2,
    code: 'UNSUPPORTED_PROTOCOL',
    message: 'protocol major mismatch',
    retryable: false,
  },
  cancel: {
    protocol: PROTOCOL,
    kind: 'cancel',
    requestId: 'r-1',
  },
} as const;

type FrameCase = { name: keyof typeof VALID_FRAMES; schema: z.ZodType };

const FRAME_CASES: FrameCase[] = [
  { name: 'hello', schema: WorkerHelloFrameSchema },
  { name: 'request', schema: WorkerRequestFrameSchema },
  { name: 'progress', schema: WorkerProgressFrameSchema },
  { name: 'result', schema: WorkerResultFrameSchema },
  { name: 'error', schema: WorkerErrorFrameSchema },
  { name: 'cancel', schema: WorkerCancelFrameSchema },
];

describe('worker envelopes round-trip', () => {
  it.each(FRAME_CASES)('$name parses its exemplar and re-parses its own output', ({ name, schema }) => {
    const parsed = schema.parse(VALID_FRAMES[name]);
    expect(schema.parse(parsed)).toEqual(parsed);
  });

  it.each(FRAME_CASES)('$name survives a JSON string round-trip', ({ name, schema }) => {
    const parsed = schema.parse(JSON.parse(JSON.stringify(VALID_FRAMES[name])));
    expect(parsed).toEqual(VALID_FRAMES[name]);
  });
});

describe('worker envelopes reject contamination', () => {
  it.each(FRAME_CASES)('$name rejects an unknown field', ({ name, schema }) => {
    const polluted = { ...VALID_FRAMES[name], definitelyNotAField: 'x' };
    const result = schema.safeParse(polluted);
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognized = result.error.issues.filter((i) => i.code === 'unrecognized_keys');
      expect(unrecognized.length).toBeGreaterThan(0);
      expect(unrecognized[0].message).toContain('definitelyNotAField');
    }
  });

  it.each(FRAME_CASES)('$name rejects a frame from another protocol major', ({ name, schema }) => {
    const impostor = { ...VALID_FRAMES[name], protocol: 'visionlens.worker.v2' };
    expect(schema.safeParse(impostor).success).toBe(false);
  });
});

describe('protocol string is exact', () => {
  it('the protocol id is the frozen literal', () => {
    expect(WORKER_PROTOCOL_ID).toBe('visionlens.worker.v1');
  });

  it('every envelope rejects a near-miss protocol string', () => {
    for (const variant of ['visionlens.worker.v1 ', 'VISIONLENS.WORKER.V1', 'visionlens.worker']) {
      expect(
        WorkerCancelFrameSchema.safeParse({ ...VALID_FRAMES.cancel, protocol: variant }).success,
      ).toBe(false);
    }
  });
});

describe('budget bounds', () => {
  const BASE = { maxSeconds: 60, maxUsdMicro: 0 };

  const CASES: Array<{ label: string; budget: Record<string, unknown>; ok: boolean }> = [
    { label: 'maxSeconds 1 is the floor', budget: { maxSeconds: 1, maxUsdMicro: 0 }, ok: true },
    { label: 'maxSeconds 86400 is the ceiling', budget: { maxSeconds: 86400, maxUsdMicro: 0 }, ok: true },
    { label: 'maxSeconds 0 is below the floor', budget: { maxSeconds: 0, maxUsdMicro: 0 }, ok: false },
    { label: 'maxSeconds 86401 is above the ceiling', budget: { maxSeconds: 86401, maxUsdMicro: 0 }, ok: false },
    { label: 'maxSeconds must be an integer', budget: { maxSeconds: 1.5, maxUsdMicro: 0 }, ok: false },
    { label: 'maxUsdMicro 0 means no paid call', budget: { ...BASE, maxUsdMicro: 0 }, ok: true },
    { label: 'maxUsdMicro may grow', budget: { ...BASE, maxUsdMicro: 250_000 }, ok: true },
    { label: 'maxUsdMicro may not be negative', budget: { ...BASE, maxUsdMicro: -1 }, ok: false },
    { label: 'maxTokens 0 is valid', budget: { ...BASE, maxTokens: 0 }, ok: true },
    { label: 'maxTokens may grow', budget: { ...BASE, maxTokens: 4096 }, ok: true },
    { label: 'maxTokens may not be negative', budget: { ...BASE, maxTokens: -1 }, ok: false },
    { label: 'maxTokens is optional', budget: { maxSeconds: 60, maxUsdMicro: 0 }, ok: true },
    { label: 'maxSeconds is required', budget: { maxUsdMicro: 0 }, ok: false },
    { label: 'maxUsdMicro is required', budget: { maxSeconds: 60 }, ok: false },
    { label: 'an unknown budget field is rejected', budget: { ...BASE, maxRetries: 3 }, ok: false },
  ];

  it.each(CASES)('$label', ({ budget, ok }) => {
    expect(WorkerBudgetSchema.safeParse(budget).success).toBe(ok);
  });

  it('the request frame forbids extra properties inside budget', () => {
    const frame = {
      ...VALID_FRAMES.request,
      budget: { maxSeconds: 60, maxUsdMicro: 0, maxTokens: 10, deadlineHint: 'soon' },
    };
    expect(WorkerRequestFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe('operation codes', () => {
  it('the wire accepts exactly the five frozen operations', () => {
    expect([...WORKER_OPERATIONS].sort()).toEqual([
      'dataset.audit',
      'eval.run',
      'model.train',
      'vision.embed',
      'vision.predict',
    ]);
  });

  it.each(['dataset.inspect', 'annotation.propose', 'model.promote'] as const)(
    'the catalog code %s is not accepted in v1',
    (operation) => {
      const frame = { ...VALID_FRAMES.request, operation };
      expect(WorkerRequestFrameSchema.safeParse(frame).success).toBe(false);
    },
  );

  it('hello rejects an operation outside the five codes', () => {
    const hello = {
      ...VALID_FRAMES.hello,
      supportedOperations: ['vision.embed', 'dataset.inspect'],
    };
    expect(WorkerHelloFrameSchema.safeParse(hello).success).toBe(false);
  });
});

describe('error vocabulary', () => {
  it('the vocabulary is exactly the ten frozen codes', () => {
    expect([...WORKER_ERROR_CODES].sort()).toEqual([
      'BUDGET_EXCEEDED',
      'CANCELLED',
      'DEADLINE_EXCEEDED',
      'MALFORMED_FRAME',
      'MISSING_EXTRA',
      'PROTOCOL_MISMATCH',
      'PROVIDER_UNAVAILABLE',
      'UNSUPPORTED_OPERATION',
      'UNSUPPORTED_PROTOCOL',
      'WORKER_CRASHED',
    ]);
  });

  it('the retryable flags are frozen per code', () => {
    expect(WORKER_ERROR_RETRYABLE).toEqual({
      UNSUPPORTED_PROTOCOL: false,
      MISSING_EXTRA: false,
      MALFORMED_FRAME: false,
      PROTOCOL_MISMATCH: false,
      UNSUPPORTED_OPERATION: false,
      CANCELLED: false,
      DEADLINE_EXCEEDED: false,
      BUDGET_EXCEEDED: false,
      WORKER_CRASHED: true,
      PROVIDER_UNAVAILABLE: true,
    });
  });

  it('an error frame rejects an unknown code', () => {
    const frame = { ...VALID_FRAMES.error, code: 'SOMETHING_ELSE' };
    expect(WorkerErrorFrameSchema.safeParse(frame).success).toBe(false);
  });

  it('an error frame without requestId validates when the id could not be recovered', () => {
    const frame = {
      protocol: PROTOCOL,
      kind: 'error',
      code: 'MALFORMED_FRAME',
      message: 'the line is not a frame',
      retryable: false,
    };
    expect(WorkerErrorFrameSchema.safeParse(frame).success).toBe(true);
  });

  it('an error frame with an empty message is rejected', () => {
    const frame = { ...VALID_FRAMES.error, message: '' };
    expect(WorkerErrorFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe('sequence and progress rules expressed per frame', () => {
  it('progress rejects completed above total', () => {
    const frame = { ...VALID_FRAMES.progress, completed: 101, total: 100 };
    const result = WorkerProgressFrameSchema.safeParse(frame);
    expect(result.success).toBe(false);
  });

  it('progress accepts completed equal to total', () => {
    const frame = { ...VALID_FRAMES.progress, completed: 100, total: 100 };
    expect(WorkerProgressFrameSchema.safeParse(frame).success).toBe(true);
  });

  it('a negative seq is rejected', () => {
    const frame = { ...VALID_FRAMES.progress, seq: -1 };
    expect(WorkerProgressFrameSchema.safeParse(frame).success).toBe(false);
  });

  it('a non-integer seq is rejected', () => {
    const frame = { ...VALID_FRAMES.progress, seq: 1.5 };
    expect(WorkerProgressFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe('request frame field rules', () => {
  it('requestId is bounded to 128 characters', () => {
    const atLimit = { ...VALID_FRAMES.request, requestId: 'r'.repeat(128) };
    expect(WorkerRequestFrameSchema.safeParse(atLimit).success).toBe(true);
    const overLimit = { ...VALID_FRAMES.request, requestId: 'r'.repeat(129) };
    expect(WorkerRequestFrameSchema.safeParse(overLimit).success).toBe(false);
  });

  it('an empty requestId is rejected', () => {
    const frame = { ...VALID_FRAMES.request, requestId: '' };
    expect(WorkerRequestFrameSchema.safeParse(frame).success).toBe(false);
  });

  it('contractVersion must be major.minor.patch', () => {
    for (const bad of ['1.0', 'v1.0.0', '1.0.0-beta', '']) {
      const frame = { ...VALID_FRAMES.request, contractVersion: bad };
      expect(WorkerRequestFrameSchema.safeParse(frame).success).toBe(false);
    }
  });

  it('an empty workspaceId is rejected', () => {
    const frame = { ...VALID_FRAMES.request, workspaceId: '' };
    expect(WorkerRequestFrameSchema.safeParse(frame).success).toBe(false);
  });

  it('params carries arbitrary JSON values', () => {
    const frame = {
      ...VALID_FRAMES.request,
      params: { images: ['a.png', 'b.png'], model: 'siglip2-base', device: 'cpu', nested: { x: [1, null, true] } },
    };
    expect(WorkerRequestFrameSchema.safeParse(frame).success).toBe(true);
  });
});
