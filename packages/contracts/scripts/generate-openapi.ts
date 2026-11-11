import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument, serializeOpenApiDocument } from '../src/openapi.js';

/**
 * Writes the generated OpenAPI 3.1 document.
 *
 * Two artefacts are produced from the SAME document, so they can never
 * disagree:
 *
 *  - `packages/contracts/dist/openapi.json` — the build artefact. It is what
 *    the package exports as `@vision-lens/contracts/openapi.json`, and it is
 *    what spec 009 serves.
 *  - `packages/contracts/openapi.snapshot.json` — the committed snapshot the
 *    drift test compares against. It is only written when `--snapshot` is
 *    passed, because a build must never modify a committed file.
 *
 * Run it with:
 *   pnpm --filter @vision-lens/contracts run openapi:generate
 *
 * Refresh the committed snapshot with:
 *   pnpm --filter @vision-lens/contracts run openapi:snapshot
 */
const document = buildOpenApiDocument();
const serialized = serializeOpenApiDocument(document);

const distTarget = fileURLToPath(new URL('../dist/openapi.json', import.meta.url));
mkdirSync(dirname(distTarget), { recursive: true });
writeFileSync(distTarget, serialized, 'utf8');
process.stdout.write(`[contracts] wrote ${distTarget}\n`);

if (process.argv.includes('--snapshot')) {
  const snapshotTarget = fileURLToPath(new URL('../openapi.snapshot.json', import.meta.url));
  writeFileSync(snapshotTarget, serialized, 'utf8');
  process.stdout.write(`[contracts] wrote ${snapshotTarget}\n`);
}
