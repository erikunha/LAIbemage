#!/usr/bin/env node
/**
 * Documentation drift check: does the `makeConfig()` fixture documented in
 * AGENTS.md still match the `Config` interface in the code?
 *
 * Usage:
 *   node scripts/check-doc-drift.mjs [--root <dir>]
 *
 * Two different questions, two different comparisons:
 *
 *   MISSING  a REQUIRED field of `Config` that the documented fixture does
 *            not set. Each one is a defect: the fixture would not typecheck.
 *   STALE    a field the documented fixture sets that the `Config` interface
 *            does not declare at all, required or optional.
 *
 * Optional fields are NOT reported as missing: the documented fixture ends
 * with `...overrides`, so it legitimately omits them.
 *
 * The check exits 1 when it finds a defect and 0 when it does not.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rootIndex = process.argv.indexOf('--root');
const root = rootIndex === -1 ? process.cwd() : process.argv[rootIndex + 1];

const AGENTS = path.join(root, 'AGENTS.md');
const CONFIG = path.join(root, 'packages', 'core', 'src', 'config', 'index.ts');

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const agents = read(AGENTS);
const config = read(CONFIG);
if (agents === undefined || config === undefined) {
  console.error(`cannot read ${agents === undefined ? AGENTS : CONFIG}`);
  process.exit(2);
}

/** The body of a top-level block that starts at `start` and ends at a lone `}`. */
function block(source, start) {
  const from = source.indexOf(start);
  if (from === -1) return '';
  const lines = source.slice(from).split('\n');
  const collected = [];
  for (const line of lines) {
    collected.push(line);
    if (line === '}') break;
  }
  return collected.join('\n');
}

const interfaceBody = block(config, 'export interface Config {');
const fixtureBody = block(agents, 'function makeConfig(');

const declared = new Map();
for (const line of interfaceBody.split('\n')) {
  const match = /^\s{2}readonly ([A-Za-z0-9_]+)(\??):/.exec(line);
  if (match) declared.set(match[1], match[2] === '?');
}

const fixture = new Set();
for (const line of fixtureBody.split('\n')) {
  const match = /^\s{4}([A-Za-z0-9_]+):/.exec(line);
  if (match) fixture.add(match[1]);
}

const missing = [...declared.entries()].filter(([name, optional]) => !optional && !fixture.has(name)).map(([name]) => name);
const stale = [...fixture].filter((name) => !declared.has(name));

if (missing.length === 0 && stale.length === 0) {
  console.log(`ok: the documented makeConfig() matches the Config interface (${declared.size} fields, ${fixture.size} in the fixture)`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`FAIL: the documented makeConfig() is missing ${missing.length} required Config field(s): ${missing.join(', ')}`);
}
if (stale.length > 0) {
  console.error(`FAIL: the documented makeConfig() sets ${stale.length} field(s) the Config interface does not declare: ${stale.join(', ')}`);
}
process.exit(1);
