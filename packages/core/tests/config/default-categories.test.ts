/**
 * The default taxonomy must ship INSIDE @vision-lens/core.
 *
 * `packages/core/src/config/index.ts` resolves the default categories file as
 * `../../examples/categories.json` relative to its own module URL. From
 * `packages/core/src/config/` (source) and `packages/core/dist/config/`
 * (published build) that is the same target:
 *
 *   packages/core/examples/categories.json
 *
 * The repository-root `examples/categories.json` is the source of truth; the
 * package-level copy is derived from it and must stay byte-identical. These
 * tests fail if the two drift apart, if the packaged copy goes missing, or if
 * a future `files` entry in packages/core/package.json stops shipping it.
 */

import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

// dotenv is mocked so loadConfig never reads the repository .env file — no
// API keys are loaded and the ambient CATEGORIES_CONFIG cannot leak in.
vi.mock('dotenv', () => ({
  config: () => ({ parsed: {} }),
}));

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

const sourceCategoriesPath = path.join(repoRoot, 'examples', 'categories.json');
const packagedCategoriesPath = path.join(packageRoot, 'examples', 'categories.json');

const originalCategoriesConfig = process.env['CATEGORIES_CONFIG'];

beforeEach(() => {
  // An empty value is falsy, so loadConfig falls back to the packaged default.
  delete process.env['CATEGORIES_CONFIG'];
});

afterEach(() => {
  if (originalCategoriesConfig === undefined) delete process.env['CATEGORIES_CONFIG'];
  else process.env['CATEGORIES_CONFIG'] = originalCategoriesConfig;
});

describe('packaged default categories file', () => {
  it('exists inside the package', () => {
    expect(readFileSync(packagedCategoriesPath).length).toBeGreaterThan(0);
  });

  it('is byte-identical to the repository-root source of truth', () => {
    const packaged = readFileSync(packagedCategoriesPath);
    const source = readFileSync(sourceCategoriesPath);

    // utf8 comparison first so a failure prints a readable diff …
    expect(packaged.toString('utf8')).toBe(source.toString('utf8'));
    // … and a strict byte comparison so no encoding trick can hide a drift.
    expect(Buffer.compare(packaged, source)).toBe(0);
  });

  it('is the file the config module falls back to when no path is supplied', async () => {
    const config = await loadConfig({ skipAnalysis: true });

    // No explicit path was given, so the default was used.
    expect(config.categoriesConfigPath).toBeUndefined();
    expect(config.categoryConfig.categories.length).toBeGreaterThan(0);

    // The default resolved to the packaged copy, which carries the same
    // taxonomy as the repository-root source of truth.
    const source = JSON.parse(readFileSync(sourceCategoriesPath, 'utf8')) as {
      categories: unknown;
    };
    expect(config.categoryConfig.categories).toEqual(source.categories);
  });

  it('is not excluded from the published tarball by a files entry', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { files?: string[] };

    if (manifest.files === undefined) return; // no files field → whole package ships

    const shipsExamples = manifest.files.some(
      (entry) => entry === 'examples' || entry === 'examples/' || entry.startsWith('examples/'),
    );
    expect(shipsExamples).toBe(true);
  });
});
