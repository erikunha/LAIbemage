import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { WorkerEventFrameSchema, WorkerRequestFrameSchema } from '../../src/index.js';

/**
 * Task 5.4: the committed worker JSON Schema artifacts are GENERATED from
 * the live zod schemas, never hand written and never stale.
 *
 * The drift test regenerates both documents in memory and compares them to
 * the committed bytes, so a worker schema change cannot land without
 * refreshing `packages/contracts/contracts/` (run
 * `pnpm --filter @vision-lens/contracts run worker-schema:snapshot`), the
 * same contract the OpenAPI snapshot enforces. The same generated documents
 * then validate the golden fixtures with ajv: one schema, two validators,
 * which is the TS side of the parity proof.
 */

const CONTRACTS_DIR = fileURLToPath(new URL('../../contracts/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/worker/', import.meta.url));

const readCommitted = (name: string): string => readFileSync(join(CONTRACTS_DIR, name), 'utf8');

/** Regenerates a document exactly the way the generator writes it. */
function regenerate(schema: z.ZodType, id: string, title: string, description: string): string {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' });
  const document = {
    ...generated,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title,
    description,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

describe('generated worker JSON Schema artifacts', () => {
  it('worker-request.v1.schema.json matches a fresh generation byte for byte', () => {
    const regenerated = regenerate(
      WorkerRequestFrameSchema,
      'https://vision-lens.dev/contracts/worker-request.v1.schema.json',
      'visionlens.worker.v1 request frame',
      'The host-to-worker request envelope of the frozen visionlens.worker.v1 JSONL protocol. Generated from the zod schema in packages/contracts/src/worker/request.ts; never hand edited.',
    );
    expect(readCommitted('worker-request.v1.schema.json')).toBe(regenerated);
  });

  it('worker-event.v1.schema.json matches a fresh generation byte for byte', () => {
    const regenerated = regenerate(
      WorkerEventFrameSchema,
      'https://vision-lens.dev/contracts/worker-event.v1.schema.json',
      'visionlens.worker.v1 event frame',
      'The worker-to-host event envelopes (progress, result, error) of the frozen visionlens.worker.v1 JSONL protocol. Generated from the zod schemas in packages/contracts/src/worker/event.ts; never hand edited.',
    );
    expect(readCommitted('worker-event.v1.schema.json')).toBe(regenerated);
  });

  it('the generated documents declare Draft 2020-12 and carry no worker-invented extensions', () => {
    for (const name of ['worker-request.v1.schema.json', 'worker-event.v1.schema.json']) {
      const document = JSON.parse(readCommitted(name)) as Record<string, unknown>;
      expect(document['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(typeof document['$id']).toBe('string');
      // Strict frames: unknown properties are forbidden, matching the zod
      // strict objects and the pack proposals.
      const text = readCommitted(name);
      expect(text).toContain('"additionalProperties": false');
    }
  });
});

describe('the generated schemas validate the golden fixtures (ajv)', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const requestValidator: ValidateFunction = ajv.compile(
    JSON.parse(readCommitted('worker-request.v1.schema.json')),
  );
  const eventValidator: ValidateFunction = ajv.compile(
    JSON.parse(readCommitted('worker-event.v1.schema.json')),
  );
  const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));

  it('request.golden.json validates', () => {
    expect(requestValidator(fixture('request.golden.json'))).toBe(true);
  });

  it('progress.golden.json and result.golden.json and error.golden.json validate', () => {
    for (const name of ['progress.golden.json', 'result.golden.json', 'error.golden.json']) {
      expect(eventValidator(fixture(name)), name).toBe(true);
    }
  });

  it('the structural rejections hold in the generated schema too', () => {
    const request = fixture('request.golden.json') as Record<string, unknown>;
    expect(requestValidator({ ...request, unknownField: true })).toBe(false);
    expect(requestValidator({ ...request, budget: undefined })).toBe(false);

    const result = fixture('result.golden.json') as Record<string, unknown>;
    // The decided option-B deviation: the proposal-only status field is
    // rejected by the generated schema exactly as it is by the zod schema.
    expect(eventValidator({ ...result, status: 'succeeded' })).toBe(false);
    expect(eventValidator({ ...request, kind: 'progress', seq: 0, completed: 2, total: 5 })).toBe(
      false,
    );
  });
});
