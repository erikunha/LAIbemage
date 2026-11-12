import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildContractManifest } from '../src/manifest.js';

/**
 * Regenerates `packages/contracts/contract-manifest.json` from the live
 * schemas (spec 002 task 1.4).
 *
 * Run it with:
 *   corepack pnpm --filter @vision-lens/contracts run manifest:generate
 *
 * `tests/version-guard.test.ts` fails when the committed manifest no longer
 * matches the live schemas, and prints this command.
 */
const target = fileURLToPath(new URL('../contract-manifest.json', import.meta.url));
const manifest = buildContractManifest();

writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`[contracts] wrote ${target}\n`);
