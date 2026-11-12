#!/usr/bin/env node
/**
 * Docker vendor drift guard.
 *
 * docker/runtime/python/visionlens is a real-file copy of the wheel source
 * (pyproject.toml, README.md, src/) because BuildKit build contexts cannot
 * follow a symlink out of the tree; docker/runtime/sync-visionlens.sh
 * refreshes it. Nothing else stops the two trees from drifting apart, so this
 * check compares the vendored subset on both sides, file sets and bytes, and
 * fails naming every differing file.
 *
 * Ignores what is never vendored: __pycache__, *.pyc, .pytest_cache, dist
 * (plus tests/, which is excluded by the subset itself).
 *
 * Run: `pnpm run docker:vendor:check` (repo root). Two optional args override
 * the source and vendor roots, in that order, for offline experiments.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/*.mjs is outside the eslint.config.js blocks that set node globals.
/* global process, console */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sourceRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'python', 'visionlens');
const vendorRoot = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(repoRoot, 'docker', 'runtime', 'python', 'visionlens');

// Exactly what sync-visionlens.sh copies: the wheel source only.
const VENDORED_ENTRIES = ['pyproject.toml', 'README.md', 'src'];

const IGNORED_NAMES = new Set(['__pycache__', '.pytest_cache', 'dist']);
const isIgnored = (name) => IGNORED_NAMES.has(name) || name.endsWith('.pyc');

// Recursive listing of every file below `root`, as forward-slash paths
// relative to `root`, skipping the ignored names.
function listFiles(root, rel = '') {
  const files = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (isIgnored(entry.name)) continue;
    const relPath = [rel, entry.name].filter(Boolean).join('/');
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

// File set of the vendored subset of one tree; a missing top-level entry is
// reported by the caller through missingEntries, not silently skipped.
function collectFiles(root, missingEntries) {
  const files = [];
  for (const entry of VENDORED_ENTRIES) {
    const abs = path.join(root, entry);
    if (!existsSync(abs)) {
      missingEntries.push(entry);
      continue;
    }
    if (statSync(abs).isFile()) {
      files.push(entry);
    } else {
      files.push(...listFiles(abs).map((f) => `${entry}/${f}`));
    }
  }
  return files.sort();
}

const problems = [];
try {
  const sourceMissing = [];
  const vendorMissing = [];
  const sourceFiles = collectFiles(sourceRoot, sourceMissing);
  const vendorFiles = collectFiles(vendorRoot, vendorMissing);

  for (const entry of sourceMissing) {
    problems.push(`missing in ${sourceRoot}: ${entry}`);
  }
  for (const entry of vendorMissing) {
    problems.push(`missing in ${vendorRoot}: ${entry}`);
  }

  const sourceSet = new Set(sourceFiles);
  const vendorSet = new Set(vendorFiles);

  for (const file of sourceFiles) {
    if (!vendorSet.has(file)) {
      problems.push(`only in python/visionlens (not vendored): ${file}`);
    }
  }
  for (const file of vendorFiles) {
    if (!sourceSet.has(file)) {
      problems.push(`only in the vendor copy (deleted upstream): ${file}`);
    }
  }
  for (const file of sourceFiles) {
    if (!vendorSet.has(file)) continue;
    const sourceBytes = readFileSync(path.join(sourceRoot, file));
    const vendorBytes = readFileSync(path.join(vendorRoot, file));
    if (!sourceBytes.equals(vendorBytes)) {
      problems.push(`differs between the trees: ${file}`);
    }
  }
} catch (error) {
  problems.push(`unexpected error: ${String(error)}`);
}

if (problems.length > 0) {
  console.error('docker vendor check FAILED: docker/runtime/python/visionlens drifted from python/visionlens');
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  console.error('Fix: run docker/runtime/sync-visionlens.sh, then rebuild the runtime image.');
  process.exit(1);
}

console.log('docker vendor check passed: docker/runtime/python/visionlens matches python/visionlens (wheel source subset)');
