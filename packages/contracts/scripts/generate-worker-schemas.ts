import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WorkerEventFrameSchema, WorkerRequestFrameSchema } from '../src/worker/index.js';

/**
 * Writes the generated JSON Schema (Draft 2020-12) of the frozen worker wire
 * protocol: the artifacts the Python side validates against, generated from
 * the SAME zod schemas the TypeScript side validates with, never hand
 * written and never hand edited (task 5.4).
 *
 *  - `packages/contracts/contracts/worker-request.v1.schema.json`
 *  - `packages/contracts/contracts/worker-event.v1.schema.json`
 *
 * Known mapping limits, deliberate and documented rather than hidden:
 *
 *  - The cross-field refinement `completed <= total` on the progress frame is
 *    a zod refinement, which JSON Schema cannot carry in this shape; the TS
 *    host enforces it on read, and the drift test pins that the generated
 *    schema still rejects the structural violations (types, bounds, unknown
 *    fields).
 *  - `z.json()` (the free-form `params` and `result` payloads) maps to an
 *    unconstrained value, which is exactly its meaning on the wire.
 *
 * Run it with:
 *   pnpm --filter @vision-lens/contracts run worker-schema:snapshot
 *
 * The drift test `packages/contracts/tests/worker/schema-generation.test.ts`
 * compares the committed files against a fresh generation, so a schema
 * change cannot land without regenerating them (the same contract the
 * OpenAPI snapshot enforces).
 */
interface Generation {
  readonly file: string;
  readonly schema: z.ZodType;
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

const GENERATIONS: readonly Generation[] = [
  {
    file: 'worker-request.v1.schema.json',
    schema: WorkerRequestFrameSchema,
    id: 'https://vision-lens.dev/contracts/worker-request.v1.schema.json',
    title: 'visionlens.worker.v1 request frame',
    description:
      'The host-to-worker request envelope of the frozen visionlens.worker.v1 JSONL protocol. Generated from the zod schema in packages/contracts/src/worker/request.ts; never hand edited.',
  },
  {
    file: 'worker-event.v1.schema.json',
    schema: WorkerEventFrameSchema,
    id: 'https://vision-lens.dev/contracts/worker-event.v1.schema.json',
    title: 'visionlens.worker.v1 event frame',
    description:
      'The worker-to-host event envelopes (progress, result, error) of the frozen visionlens.worker.v1 JSONL protocol. Generated from the zod schemas in packages/contracts/src/worker/event.ts; never hand edited.',
  },
] as const;

for (const generation of GENERATIONS) {
  const generated = z.toJSONSchema(generation.schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  // The envelope keys are pinned AFTER the spread so the canonical dialect
  // line, the id, the title and the provenance description always win over
  // whatever zod emitted at the root.
  const document = {
    ...generated,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: generation.id,
    title: generation.title,
    description: generation.description,
  };

  const target = fileURLToPath(new URL(`../contracts/${generation.file}`, import.meta.url));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  process.stdout.write(`[contracts] wrote ${target}\n`);
}
