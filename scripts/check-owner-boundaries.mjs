#!/usr/bin/env node
/**
 * Owner-boundary proof (spec 016, task 2.1): the static half of the
 * Python-first ML runtime decision (docs/adr/011-python-first-ml-runtime.md,
 * owner map docs/architecture/python-owner-map.md).
 *
 * The rules are the import directions of the owner map, each observable in
 * the tree today:
 *
 *   PY-NO-TS        Python code (python/ and services/) imports no TypeScript
 *                   package: no `@scope/name` specifier, no `node:` builtin,
 *                   no module path rooted at `packages` or `apps`, no path
 *                   reach into `python/` source by module path, and no
 *                   relative import escaping its scanned root
 *                   (AGENTS.md boundary row for services/*).
 *   HOST-NO-PYTHON  packages/core/src/worker/ never reaches into the Python
 *                   tree: no import specifier resolves toward python/ or
 *                   services/, and no string literal names a path into them.
 *                   The launch seam is the environment
 *                   (packages/core/src/worker/client.ts, WORKER_INTERPRETER_ENV).
 *   HOST-IMPORTS    packages/core/src/worker/ imports only the Node stdlib,
 *                   @vision-lens/contracts, its own directory and
 *                   packages/core/src/utils/ (the AGENTS.md boundary row for
 *                   packages/core/src/worker/).
 *   PROTOCOL-PARITY The frozen visionlens.worker.v1 vocabulary is defined
 *                   twice, once per language
 *                   (packages/contracts/src/worker/protocol.ts and
 *                   python/visionlens/src/visionlens/protocol.py + errors.py),
 *                   and the two definitions must agree: protocol id, major,
 *                   version, the five operation codes, the ten error codes
 *                   and every retryable flag.
 *   CONTRACT-VERSION The contract version the Python side stamps on frames
 *                   equals CONTRACTS_VERSION in packages/contracts.
 *
 * Fails closed: any violation exits 1, an unreadable protocol surface exits 1
 * as a PROTOCOL-SURFACE violation, and the script proves its own scanner
 * fires by planting violating fixtures in a scratch tree under the OS temp
 * directory and asserting each rule reddens (a green run therefore means the
 * rules are genuinely enforced, not vacuous).
 *
 * Usage: node scripts/check-owner-boundaries.mjs [--root <dir>]
 * Run: `pnpm run check:owner-boundaries` (repo root).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/*.mjs is outside the eslint.config.js blocks that set node globals.
/* global process, console */

const rootIndex = process.argv.indexOf('--root');
const rootArg = rootIndex === -1 ? undefined : process.argv[rootIndex + 1];
const root = rootArg === undefined ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : path.resolve(rootArg);

if (rootArg !== undefined && !readdirSyncSafe(root)) {
  console.error(`cannot read root: ${root}`);
  process.exit(2);
}

function readdirSyncSafe(dir) {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Directory names never scanned (build output, caches, tooling state). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
]);

/** Collect files under `dir` (relative to `dir`) whose relative path matches `ext`. */
function walk(dir, ext, relativeTo = dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, ext, relativeTo, acc);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      acc.push({ absolute, relative: path.relative(relativeTo, absolute).split(path.sep).join('/') });
    }
  }
  return acc;
}

/** Python roots of the owner map: the public distribution and the services. */
const PY_ROOTS = ['python', 'services'];

/** One `import x` / `from x import` statement of a Python file. */
const PY_IMPORT_RE = /^\s*(?:import\s+([A-Za-z_][\w.,\s]*?)\s*(?:#.*)?$|from\s+([.\w]+)\s+import\s+)/;

/** Why an absolute Python module target is forbidden, or null when allowed. */
function pyAbsoluteViolation(target) {
  if (target.includes('@')) return 'a JavaScript package specifier';
  if (target.startsWith('node:')) return 'a Node builtin';
  const head = target.split('.')[0];
  if (head === 'packages' || head === 'apps') return 'a TypeScript workspace tree';
  if (head === 'python') return 'the Python distribution source tree by module path';
  return null;
}

/** Scan one Python root; every violation is an owner-boundary break. */
function scanPython(scanRootDir, scanRootLabel) {
  const violations = [];
  for (const file of walk(scanRootDir, '.py')) {
    const lines = readFileSync(file.absolute, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(PY_IMPORT_RE);
      if (match === null) continue;
      const targets = match[2] !== undefined ? [match[2]] : match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0].trim()).filter((part) => part !== '');
      for (const target of targets) {
        if (target.startsWith('.')) {
          // Relative import: resolve the leading dots and require the result
          // to stay inside the scanned root.
          const dots = target.length - target.replace(/^\.+/, '').length;
          let base = path.dirname(file.absolute);
          for (let up = 1; up < dots; up += 1) base = path.dirname(base);
          if (path.relative(scanRootDir, base).startsWith('..')) {
            violations.push(`PY-NO-TS: ${file.relative}:${index + 1}: relative import "${target}" escapes ${scanRootLabel}`);
          }
          continue;
        }
        const reason = pyAbsoluteViolation(target);
        if (reason !== null) {
          violations.push(`PY-NO-TS: ${file.relative}:${index + 1}: imports ${reason} ("${target}")`);
        }
      }
    }
  }
  return violations;
}

/** The AGENTS.md allowlist for packages/core/src/worker/, as prefix rules. */
function workerImportAllowed(specifier, workerDir) {
  if (/^node:\w/.test(specifier)) return true;
  if (specifier === '@vision-lens/contracts' || specifier.startsWith('@vision-lens/contracts/')) return true;
  if (specifier.startsWith('./')) {
    const resolved = path.resolve(workerDir, specifier);
    return path.relative(workerDir, resolved).startsWith('..') === false;
  }
  if (specifier === '../utils' || specifier.startsWith('../utils/')) return true;
  return false;
}

/** Path literals that would couple the host to Python source locations. */
const HOST_PATH_LITERAL = /(?:python|services)\/(?:visionlens|vision|training|agents)/;

/** Scan the TypeScript worker host. */
function scanWorkerHost(workerDir) {
  const violations = [];
  for (const file of walk(workerDir, '.ts')) {
    const text = readFileSync(file.absolute, 'utf8');
    const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const leading of text.matchAll(/^import\s+'([^']+)'/gm)) specifiers.push(leading[1]);
    for (const specifier of specifiers) {
      const reachesPython = /(^|[/'"])((?:\.\.\/)+)?python\//.test(specifier) || specifier.includes('services/');
      if (reachesPython) {
        violations.push(`HOST-NO-PYTHON: ${file.relative}: import "${specifier}" reaches toward the Python tree; the only coupling is the protocol`);
      } else if (!workerImportAllowed(specifier, workerDir)) {
        violations.push(`HOST-IMPORTS: ${file.relative}: import "${specifier}" is outside the worker allowlist (Node stdlib, @vision-lens/contracts, worker/, utils/)`);
      }
    }
    if (HOST_PATH_LITERAL.test(text)) {
      violations.push(`HOST-NO-PYTHON: ${file.relative}: names a Python source path; the launch seam is the environment (WORKER_INTERPRETER_ENV / WORKER_SCRIPT_ENV)`);
    }
  }
  return violations;
}

function mustRead(file, violations, rule) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    violations.push(`${rule}: cannot read ${file}`);
    return undefined;
  }
}

/** Parse `export const NAME = [ 'a', 'b' ] as const;` string arrays. */
function tsStringArray(source, name, violations, file) {
  const start = source.indexOf(`export const ${name} = [`);
  if (start === -1) {
    violations.push(`PROTOCOL-SURFACE: cannot find ${name} in ${file}`);
    return undefined;
  }
  const end = source.indexOf(']', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** Parse `export const NAME = { CODE: true, ... } as const`; */
function tsBoolMap(source, name, violations, file) {
  const start = source.indexOf(`export const ${name} = {`);
  if (start === -1) {
    violations.push(`PROTOCOL-SURFACE: cannot find ${name} in ${file}`);
    return undefined;
  }
  const end = source.indexOf('}', start);
  const body = source.slice(start, end);
  const map = {};
  for (const match of body.matchAll(/([A-Z_]+):\s*(true|false)/g)) map[match[1]] = match[2] === 'true';
  return map;
}

/** Parse a Python `NAME = ( "a", "b", )` tuple or `"x"` constant. */
function pyTuple(source, name, violations, file) {
  const start = source.indexOf(`${name} = (`);
  if (start === -1) {
    violations.push(`PROTOCOL-SURFACE: cannot find ${name} in ${file}`);
    return undefined;
  }
  const end = source.indexOf(')', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function pyConst(source, name, violations, file) {
  const match = source.match(new RegExp(`^${name} = "([^"]+)"`, 'm'));
  if (match === null) {
    violations.push(`PROTOCOL-SURFACE: cannot find ${name} in ${file}`);
    return undefined;
  }
  return match[1];
}

function pyConstNumber(source, name, violations, file) {
  const match = source.match(new RegExp(`^${name} = (\\d+)`, 'm'));
  if (match === null) {
    violations.push(`PROTOCOL-SURFACE: cannot find ${name} in ${file}`);
    return undefined;
  }
  return Number(match[1]);
}

/** Parse the ErrorCode enum members and the _RETRYABLE map of errors.py. */
function pyErrorVocabularies(source) {
  const classStart = source.indexOf('class ErrorCode');
  const classEnd = source.indexOf('\nclass ', classStart + 1);
  const classBody = source.slice(classStart, classEnd === -1 ? undefined : classEnd);
  const codes = [...classBody.matchAll(/^\s{4}([A-Z_]+) = "[A-Z_]+"/gm)].map((match) => match[1]);
  const retryable = {};
  for (const match of source.matchAll(/ErrorCode\.([A-Z_]+):\s*(True|False)/g)) {
    retryable[match[1]] = match[2] === 'True';
  }
  return { codes, retryable };
}

/** The frozen vocabulary must be identical on both sides of the boundary. */
function scanProtocolParity(scanRoot) {
  const violations = [];
  const tsProtocolPath = path.join(scanRoot, 'packages', 'contracts', 'src', 'worker', 'protocol.ts');
  const tsVersionPath = path.join(scanRoot, 'packages', 'contracts', 'src', 'version.ts');
  const pyProtocolPath = path.join(scanRoot, 'python', 'visionlens', 'src', 'visionlens', 'protocol.py');
  const pyErrorsPath = path.join(scanRoot, 'python', 'visionlens', 'src', 'visionlens', 'errors.py');

  const ts = mustRead(tsProtocolPath, violations, 'PROTOCOL-SURFACE');
  const tsVersion = mustRead(tsVersionPath, violations, 'PROTOCOL-SURFACE');
  const py = mustRead(pyProtocolPath, violations, 'PROTOCOL-SURFACE');
  const pyErrors = mustRead(pyErrorsPath, violations, 'PROTOCOL-SURFACE');
  if (ts === undefined || tsVersion === undefined || py === undefined || pyErrors === undefined) {
    return violations;
  }

  const tsId = ts.match(/export const WORKER_PROTOCOL_ID = '([^']+)'/);
  const tsMajor = ts.match(/export const WORKER_PROTOCOL_MAJOR = (\d+)/);
  const tsVersionMatch = ts.match(/export const WORKER_PROTOCOL_VERSION = '([^']+)'/);
  const tsOperations = tsStringArray(ts, 'WORKER_OPERATIONS', violations, 'packages/contracts/src/worker/protocol.ts');
  const tsErrorCodes = tsStringArray(ts, 'WORKER_ERROR_CODES', violations, 'packages/contracts/src/worker/protocol.ts');
  const tsRetryable = tsBoolMap(ts, 'WORKER_ERROR_RETRYABLE', violations, 'packages/contracts/src/worker/protocol.ts');
  const contractsVersion = tsVersion.match(/export const CONTRACTS_VERSION = '([^']+)'/);

  // Fail closed on unreadable TypeScript scalars: a constant whose declaration
  // no longer matches the regex is a protocol-surface change, not a skip (the
  // array parsers above already fail closed the same way).
  const tsSurface = (match, name, file) => {
    if (match === null) {
      violations.push(`PROTOCOL-SURFACE: cannot find ${name} in ${file}`);
    }
    return match;
  };
  tsSurface(tsId, 'WORKER_PROTOCOL_ID', 'packages/contracts/src/worker/protocol.ts');
  tsSurface(tsMajor, 'WORKER_PROTOCOL_MAJOR', 'packages/contracts/src/worker/protocol.ts');
  tsSurface(tsVersionMatch, 'WORKER_PROTOCOL_VERSION', 'packages/contracts/src/worker/protocol.ts');
  tsSurface(contractsVersion, 'CONTRACTS_VERSION', 'packages/contracts/src/version.ts');

  const pyId = pyConst(py, 'PROTOCOL', violations, 'python/visionlens/src/visionlens/protocol.py');
  const pyMajor = pyConstNumber(py, 'PROTOCOL_MAJOR', violations, 'python/visionlens/src/visionlens/protocol.py');
  const pyVersion = pyConst(py, 'PROTOCOL_VERSION', violations, 'python/visionlens/src/visionlens/protocol.py');
  const pyContractVersion = pyConst(py, 'CONTRACT_VERSION', violations, 'python/visionlens/src/visionlens/protocol.py');
  const pyOperations = pyTuple(py, 'OPERATIONS', violations, 'python/visionlens/src/visionlens/protocol.py');
  const { codes: pyErrorCodes, retryable: pyRetryable } = pyErrorVocabularies(pyErrors);

  const mismatch = (what, tsSide, pySide) =>
    violations.push(`PROTOCOL-PARITY: ${what} disagree: TypeScript has ${JSON.stringify(tsSide)}, Python has ${JSON.stringify(pySide)}`);

  if (tsId !== null && pyId !== undefined && tsId[1] !== pyId) mismatch('protocol ids', tsId[1], pyId);
  if (tsMajor !== null && pyMajor !== undefined && Number(tsMajor[1]) !== pyMajor) mismatch('protocol majors', Number(tsMajor[1]), pyMajor);
  if (tsVersionMatch !== null && pyVersion !== undefined && tsVersionMatch[1] !== pyVersion) mismatch('protocol versions', tsVersionMatch[1], pyVersion);
  if (tsOperations !== undefined && pyOperations !== undefined && JSON.stringify(tsOperations) !== JSON.stringify(pyOperations)) {
    mismatch('operation codes', tsOperations, pyOperations);
  }
  if (tsErrorCodes !== undefined && pyErrorCodes !== undefined && JSON.stringify(tsErrorCodes) !== JSON.stringify(pyErrorCodes)) {
    mismatch('error codes', tsErrorCodes, pyErrorCodes);
  }
  if (tsRetryable !== undefined && pyErrorCodes.length > 0) {
    const keys = new Set([...Object.keys(tsRetryable), ...Object.keys(pyRetryable)]);
    for (const code of keys) {
      if (tsRetryable[code] !== pyRetryable[code]) {
        mismatch(`retryable flags for ${code}`, tsRetryable[code], pyRetryable[code]);
      }
    }
  }
  if (contractsVersion !== null && pyContractVersion !== undefined && contractsVersion[1] !== pyContractVersion) {
    violations.push(`CONTRACT-VERSION: the worker stamps contract ${JSON.stringify(pyContractVersion)} but packages/contracts is ${JSON.stringify(contractsVersion[1])}`);
  }
  return violations;
}

/** Run every rule against one tree. */
function scanTree(scanRoot) {
  const violations = [];
  let pythonFiles = 0;
  for (const label of PY_ROOTS) {
    const dir = path.join(scanRoot, label);
    if (!readdirSyncSafe(dir)) continue;
    violations.push(...scanPython(dir, `${label}/`));
    pythonFiles += walk(dir, '.py').length;
  }
  const workerDir = path.join(scanRoot, 'packages', 'core', 'src', 'worker');
  let workerFiles = 0;
  if (readdirSyncSafe(workerDir)) {
    violations.push(...scanWorkerHost(workerDir));
    workerFiles = walk(workerDir, '.ts').length;
  }
  violations.push(...scanProtocolParity(scanRoot));
  return { violations, pythonFiles, workerFiles };
}

// ---------------------------------------------------------------------------
// Self-proof: a green run must mean the rules fire, so the scanner is turned
// on planted violations in a scratch tree under the OS temp directory.
// ---------------------------------------------------------------------------

const FIXTURE_PROTOCOL_TS = `export const WORKER_PROTOCOL_ID = 'visionlens.worker.v1';
export const WORKER_PROTOCOL_MAJOR = 1;
export const WORKER_PROTOCOL_VERSION = '1.0.0';
export const WORKER_OPERATIONS = [
  'vision.embed',
] as const;
export const WORKER_ERROR_CODES = [
  'WORKER_CRASHED',
] as const;
export const WORKER_ERROR_RETRYABLE = {
  WORKER_CRASHED: true,
} as const;
`;

const FIXTURE_VERSION_TS = `export const CONTRACTS_VERSION = '1.0.0';
`;

const FIXTURE_PROTOCOL_PY = `PROTOCOL = "visionlens.worker.v1"
PROTOCOL_VERSION = "1.0.0"
PROTOCOL_MAJOR = 1
CONTRACT_VERSION = "1.0.0"
OPERATIONS = (
    "vision.embed",
)
`;

const FIXTURE_ERRORS_PY = `import enum


class ErrorCode(str, enum.Enum):
    WORKER_CRASHED = "WORKER_CRASHED"


_RETRYABLE: dict[ErrorCode, bool] = {
    ErrorCode.WORKER_CRASHED: True,
}
`;

const FIXTURE_CLEAN_PY = `import json

from . import protocol
`;

const FIXTURE_CLEAN_TS = `import { spawn } from 'node:child_process';
import { WORKER_PROTOCOL_ID } from '@vision-lens/contracts';
import { encodeFrame } from './framing.js';

export const protocolId = WORKER_PROTOCOL_ID;
export const frame = encodeFrame;
export const launch = spawn;
`;

/** A minimal clean tree that satisfies every rule. */
function writeBaseTree(dir) {
  const pyDir = path.join(dir, 'python', 'visionlens', 'src', 'visionlens');
  const contractsWorkerDir = path.join(dir, 'packages', 'contracts', 'src', 'worker');
  const coreWorkerDir = path.join(dir, 'packages', 'core', 'src', 'worker');
  mkdirSync(pyDir, { recursive: true });
  mkdirSync(contractsWorkerDir, { recursive: true });
  mkdirSync(coreWorkerDir, { recursive: true });
  writeFileSync(path.join(pyDir, 'protocol.py'), FIXTURE_PROTOCOL_PY);
  writeFileSync(path.join(pyDir, 'errors.py'), FIXTURE_ERRORS_PY);
  writeFileSync(path.join(pyDir, 'clean.py'), FIXTURE_CLEAN_PY);
  writeFileSync(path.join(contractsWorkerDir, 'protocol.ts'), FIXTURE_PROTOCOL_TS);
  writeFileSync(path.join(path.join(dir, 'packages', 'contracts', 'src'), 'version.ts'), FIXTURE_VERSION_TS);
  writeFileSync(path.join(coreWorkerDir, 'framing.ts'), 'export function encodeFrame(): string {\n  return "";\n}\n');
  writeFileSync(path.join(coreWorkerDir, 'clean.ts'), FIXTURE_CLEAN_TS);
}

function selfProof() {
  const failures = [];
  const base = mkdtempSync(path.join(os.tmpdir(), 'owner-boundaries-selfproof-'));
  try {
    // Case A: PY-NO-TS fires on a Python file importing a TS workspace tree.
    const caseA = path.join(base, 'a');
    writeBaseTree(caseA);
    writeFileSync(
      path.join(caseA, 'python', 'visionlens', 'src', 'visionlens', 'leak.py'),
      `from packages.contracts.src.worker.protocol import WORKER_PROTOCOL_ID\n`,
    );
    const a = scanTree(caseA);
    if (!a.violations.some((line) => line.startsWith('PY-NO-TS:'))) {
      failures.push(`PY-NO-TS did not fire on a planted TypeScript import (got: ${a.violations.join('; ') || 'nothing'})`);
    }

    // Case B: HOST-NO-PYTHON and HOST-IMPORTS fire inside the worker host.
    const caseB = path.join(base, 'b');
    writeBaseTree(caseB);
    writeFileSync(
      path.join(caseB, 'packages', 'core', 'src', 'worker', 'leak.ts'),
      `import { Worker } from '../../../../python/visionlens/src/visionlens/worker.py';\nimport command from 'commander';\nexport const leak = { Worker, command };\n`,
    );
    const b = scanTree(caseB);
    if (!b.violations.some((line) => line.startsWith('HOST-NO-PYTHON:'))) {
      failures.push(`HOST-NO-PYTHON did not fire on a planted Python-reaching import (got: ${b.violations.join('; ') || 'nothing'})`);
    }
    if (!b.violations.some((line) => line.startsWith('HOST-IMPORTS:'))) {
      failures.push(`HOST-IMPORTS did not fire on a planted off-allowlist import (got: ${b.violations.join('; ') || 'nothing'})`);
    }

    // Case C: PROTOCOL-PARITY fires when the two vocabularies disagree.
    const caseC = path.join(base, 'c');
    writeBaseTree(caseC);
    writeFileSync(
      path.join(caseC, 'python', 'visionlens', 'src', 'visionlens', 'protocol.py'),
      FIXTURE_PROTOCOL_PY.replace('"vision.embed"', '"vision.ooze"'),
    );
    const c = scanTree(caseC);
    if (!c.violations.some((line) => line.startsWith('PROTOCOL-PARITY:'))) {
      failures.push(`PROTOCOL-PARITY did not fire on a drifted operation code (got: ${c.violations.join('; ') || 'nothing'})`);
    }
    if (c.violations.some((line) => line.startsWith('CONTRACT-VERSION:'))) {
      failures.push('CONTRACT-VERSION fired on a clean contract version pair (false positive)');
    }

    // Case D: the clean base tree produces zero violations.
    const caseD = path.join(base, 'd');
    writeBaseTree(caseD);
    const d = scanTree(caseD);
    if (d.violations.length !== 0) {
      failures.push(`the clean fixture tree produced violations: ${d.violations.join('; ')}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  return failures;
}

// ---------------------------------------------------------------------------

const scanned = scanTree(root);
if (scanned.violations.length > 0) {
  for (const violation of scanned.violations) console.error(`FAIL ${violation}`);
  console.error('owner boundary check FAILED');
  process.exit(1);
}

const proofFailures = selfProof();
if (proofFailures.length > 0) {
  for (const failure of proofFailures) console.error(`FAIL self-proof: ${failure}`);
  console.error('owner boundary check FAILED: the scanner did not prove itself');
  process.exit(1);
}

console.log(
  `owner boundary check passed: ${scanned.pythonFiles} Python files import no TypeScript, ` +
    `${scanned.workerFiles} worker host files stay on the protocol, the visionlens.worker.v1 ` +
    'vocabulary is identical on both sides, and the self-proof fired on every planted violation',
);
