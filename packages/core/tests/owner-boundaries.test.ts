import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Owner-boundary enforcement (spec 016, the Python-first ML runtime ADR):
 * `scripts/check-owner-boundaries.mjs` (also `pnpm run
 * check:owner-boundaries`) proves the import directions of
 * `docs/architecture/python-owner-map.md` against the working tree.
 *
 * Both directions are asserted here, mirroring how boundaries.test.ts proves
 * check-boundaries.mjs:
 *
 *   - the clean tree passes (exit 0), and
 *   - a scratch tree under the OS temp directory that copies the real protocol
 *     files and plants a violation is rejected (exit 1) with the rule id named.
 */
vi.setConfig({ testTimeout: 60_000 }); // walks python/, services/ and the worker host

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repoRoot, 'scripts', 'check-owner-boundaries.mjs');

/**
 * Copy the real protocol surface into a scratch root, so PROTOCOL-PARITY and
 * CONTRACT-VERSION stay satisfied and only the planted violation fires.
 */
function writeScratchTree(root: string): void {
  const pyDir = path.join(root, 'python', 'visionlens', 'src', 'visionlens');
  const contractsSrc = path.join(root, 'packages', 'contracts', 'src');
  const workerDir = path.join(root, 'packages', 'core', 'src', 'worker');
  mkdirSync(pyDir, { recursive: true });
  mkdirSync(path.join(contractsSrc, 'worker'), { recursive: true });
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    path.join(pyDir, 'protocol.py'),
    readFileSync(path.join(repoRoot, 'python', 'visionlens', 'src', 'visionlens', 'protocol.py'), 'utf8'),
  );
  writeFileSync(
    path.join(pyDir, 'errors.py'),
    readFileSync(path.join(repoRoot, 'python', 'visionlens', 'src', 'visionlens', 'errors.py'), 'utf8'),
  );
  writeFileSync(
    path.join(contractsSrc, 'worker', 'protocol.ts'),
    readFileSync(path.join(repoRoot, 'packages', 'contracts', 'src', 'worker', 'protocol.ts'), 'utf8'),
  );
  writeFileSync(
    path.join(contractsSrc, 'version.ts'),
    readFileSync(path.join(repoRoot, 'packages', 'contracts', 'src', 'version.ts'), 'utf8'),
  );
}

describe('owner boundary enforcement (python-owner-map.md)', () => {
  it('passes on the clean tree', () => {
    const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('owner boundary check passed');
  });

  it('rejects planted Python-to-TypeScript and host-to-Python violations', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'owner-boundaries-test-'));
    try {
      writeScratchTree(scratch);
      writeFileSync(
        path.join(scratch, 'python', 'visionlens', 'src', 'visionlens', 'leak.py'),
        'from packages.contracts.src.worker.protocol import WORKER_PROTOCOL_ID\n\nLEAK = WORKER_PROTOCOL_ID\n',
      );
      writeFileSync(
        path.join(scratch, 'packages', 'core', 'src', 'worker', 'leak.ts'),
        "import { Worker } from '../../../../python/visionlens/src/visionlens/worker.py';\n\nexport const leak = Worker;\n",
      );
      const result = spawnSync(process.execPath, [script, '--root', scratch], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('PY-NO-TS');
      expect(result.stdout + result.stderr).toContain('HOST-NO-PYTHON');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a protocol vocabulary that drifts between the two languages', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'owner-boundaries-test-'));
    try {
      writeScratchTree(scratch);
      const pythonProtocol = path.join(scratch, 'python', 'visionlens', 'src', 'visionlens', 'protocol.py');
      writeFileSync(pythonProtocol, readFileSync(pythonProtocol, 'utf8').replace('"vision.embed"', '"vision.ooze"'));
      const result = spawnSync(process.execPath, [script, '--root', scratch], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('PROTOCOL-PARITY');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
