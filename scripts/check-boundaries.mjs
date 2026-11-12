#!/usr/bin/env node
/**
 * Boundary-rule proof (spec 001, task 2.3 — implemented via this script).
 *
 * Spawns eslint on two throwaway fixture files placed under
 * `packages/core/tests/` (a path matched by eslint.config.js `files` globs but
 * outside the `packages/core/src/analyzer/providers/**` carve-out):
 *
 *   - violating.ts imports the `openai` SDK  → eslint MUST fail (exit 1)
 *   - clean.ts       imports only node:path  → eslint MUST pass (exit 0)
 *
 * A second proof pair covers the worker boundary rule scoped to
 * `packages/core/src/worker/` (the boundary-table row in AGENTS.md), so its
 * fixtures live under that directory where the scoped rule matches:
 *
 *   - worker-violating.ts imports `sharp`      → eslint MUST fail (exit 1)
 *   - worker-clean.ts     stdlib + contracts   → eslint MUST pass (exit 0)
 *
 * Any other outcome (config errors = exit 2, crashes) fails the check.
 * Run: `pnpm run check:boundaries` (repo root). Wired into CI later.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslintBin = path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');

// Under packages/core/tests/ so the eslint.config.js `files` globs match;
// NOT under packages/core/src/analyzer/providers/ (the SDK carve-out).
const tmpDir = path.join(repoRoot, 'packages', 'core', 'tests', `boundary-check-tmp-${process.pid}`);

// Under packages/core/src/worker/ so the worker-scoped boundary rule matches.
const workerTmpDir = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'worker',
  `boundary-check-tmp-${process.pid}`,
);

const VIOLATING = `import OpenAI from 'openai';
// Deliberate boundary violation fixture — must trip no-restricted-imports.
export const client = OpenAI;
`;

const CLEAN = `import path from 'node:path';
// Clean fixture — no LLM SDK import, must lint green.
export const joined = path.join('a', 'b');
`;

const WORKER_VIOLATING = `import sharp from 'sharp';
// Deliberate worker boundary violation fixture: Sharp inside the process
// spawning module must trip the scoped no-restricted-imports rule.
export const imaging = sharp;
`;

const WORKER_CLEAN = `import { spawn } from 'node:child_process';
import { WORKER_PROTOCOL_ID } from '@vision-lens/contracts';
// Clean worker fixture: node stdlib plus contracts, must lint green.
export const protocol = WORKER_PROTOCOL_ID;
export const spawnWorker = spawn;
`;

function runEslint(file) {
  return spawnSync(process.execPath, [eslintBin, '--no-color', file], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

let failed = false;
try {
  mkdirSync(tmpDir);
  const violatingFile = path.join(tmpDir, 'violating.ts');
  const cleanFile = path.join(tmpDir, 'clean.ts');
  writeFileSync(violatingFile, VIOLATING);
  writeFileSync(cleanFile, CLEAN);

  const violating = runEslint(violatingFile);
  if (violating.status !== 1) {
    failed = true;
    console.error(
      `FAIL: violating fixture should exit 1 (LLM SDK outside providers/), got ${violating.status}\n${violating.stdout}${violating.stderr}`,
    );
  } else if (
    !violating.stdout.includes('no-restricted-imports') ||
    !violating.stdout.includes('packages/core/src/analyzer/providers')
  ) {
    failed = true;
    console.error(
      `FAIL: violation reported, but not by the boundary rule:\n${violating.stdout}`,
    );
  } else {
    console.log('ok: LLM SDK import outside providers/ is rejected (no-restricted-imports)');
  }

  const clean = runEslint(cleanFile);
  if (clean.status !== 0) {
    failed = true;
    console.error(`FAIL: clean fixture should exit 0, got ${clean.status}\n${clean.stdout}${clean.stderr}`);
  } else {
    console.log('ok: clean fixture (node:path only) lints green');
  }

  mkdirSync(workerTmpDir);
  const workerViolatingFile = path.join(workerTmpDir, 'worker-violating.ts');
  const workerCleanFile = path.join(workerTmpDir, 'worker-clean.ts');
  writeFileSync(workerViolatingFile, WORKER_VIOLATING);
  writeFileSync(workerCleanFile, WORKER_CLEAN);

  const workerViolating = runEslint(workerViolatingFile);
  if (workerViolating.status !== 1) {
    failed = true;
    console.error(
      `FAIL: worker violating fixture should exit 1 (Sharp inside worker/), got ${workerViolating.status}\n${workerViolating.stdout}${workerViolating.stderr}`,
    );
  } else if (
    !workerViolating.stdout.includes('no-restricted-imports') ||
    !workerViolating.stdout.includes('packages/core/src/worker')
  ) {
    failed = true;
    console.error(
      `FAIL: worker violation reported, but not by the worker boundary rule:\n${workerViolating.stdout}`,
    );
  } else {
    console.log('ok: Sharp import inside worker/ is rejected (no-restricted-imports)');
  }

  const workerClean = runEslint(workerCleanFile);
  if (workerClean.status !== 0) {
    failed = true;
    console.error(
      `FAIL: worker clean fixture should exit 0, got ${workerClean.status}\n${workerClean.stdout}${workerClean.stderr}`,
    );
  } else {
    console.log('ok: worker clean fixture (node:child_process + contracts) lints green');
  }
} catch (error) {
  failed = true;
  console.error(`FAIL: unexpected error: ${String(error)}`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(workerTmpDir, { recursive: true, force: true });
}

if (failed) {
  console.error('boundary check FAILED');
  process.exit(1);
}
console.log('boundary check passed: LLM SDK and worker violating fixtures caught, clean fixtures green');
