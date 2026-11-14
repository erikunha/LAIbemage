#!/usr/bin/env node
/**
 * Generate the JSON Schema of the embedding manifest.
 *
 * The manifest is a contract between two languages: the Python runtime
 * writes it and the TypeScript side validates it. The schema is
 * generated from the same Zod schema the TypeScript side validates
 * with, so the two can never drift, and the Python side validates
 * against the generated file.
 *
 * Run: `pnpm exec tsx scripts/benchmarks/generate-manifest-schema.ts`
 *
 * With `--check` the command compares the generated schema with the
 * committed one and exits 1 when they differ. That is the gate: the
 * committed file is never rewritten by a test.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { embeddingManifestJsonSchema } from '../../packages/core/src/adapter/embedding-manifest.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaPath = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'adapter',
  'embedding-manifest.schema.json',
);

function main(): number {
  const generated = JSON.stringify(embeddingManifestJsonSchema(), null, 2);
  const payload = generated + '\n';

  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(schemaPath, 'utf8');
    } catch {
      console.error(`the manifest schema is not committed at ${schemaPath}`);
      return 1;
    }
    if (committed !== payload) {
      console.error(
        'the committed manifest schema differs from the one the Zod schema generates: run pnpm exec tsx scripts/benchmarks/generate-manifest-schema.ts',
      );
      return 1;
    }
    console.log('manifest schema is in sync with the Zod schema');
    return 0;
  }

  writeFileSync(schemaPath, payload, 'utf8');
  console.log(`manifest schema written: ${schemaPath}`);
  return 0;
}

process.exit(main());
