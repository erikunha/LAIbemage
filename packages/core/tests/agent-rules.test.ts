import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findProblems, main } from '../../../scripts/generate-agent-rules.js';

/**
 * The path-scoped rules have one canonical body under `.agents/rules/` and one
 * adapter per runtime. The gate proves the three properties that matter:
 *
 * 1. every adapter matches its canonical rule;
 * 2. every rule's `paths:` matches at least one real file, because a glob that
 *    matches nothing is a silent hole;
 * 3. no adapter exists without a canonical rule behind it.
 *
 * Each negative control breaks one property in a temporary tree and asserts
 * that the gate says so. A gate that only ever sees the good state proves
 * nothing.
 */
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'agent-rules-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * A minimal tree with one canonical rule and its two adapters.
 */
function writeTree(options?: {
  readonly glob?: string;
  readonly omitName?: boolean;
  readonly adapterBody?: string;
  readonly orphanAdapter?: boolean;
}): void {
  const glob = options?.glob ?? 'packages/core/src/**';
  const canonicalDir = path.join(workDir, '.agents', 'rules');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(path.join(workDir, 'packages', 'core', 'src'), { recursive: true });
  writeFileSync(path.join(workDir, 'packages', 'core', 'src', 'index.ts'), 'export const a = 1;\n');

  const frontmatter = [
    '---',
    ...(options?.omitName === true ? [] : ['name: sample']),
    'paths:',
    `  - ${glob}`,
    '---',
    '',
    '# Sample rule',
    '',
    'A rule body.',
    '',
  ].join('\n');
  writeFileSync(path.join(canonicalDir, 'sample.md'), frontmatter, 'utf8');

  const body = options?.adapterBody ?? '# Sample rule\n\nA rule body.\n';
  mkdirSync(path.join(workDir, '.claude', 'rules'), { recursive: true });
  writeFileSync(
    path.join(workDir, '.claude', 'rules', 'sample.md'),
    `---\npaths:\n  - ${glob}\n---\n\n${body}`,
    'utf8',
  );

  mkdirSync(path.join(workDir, '.github', 'instructions'), { recursive: true });
  writeFileSync(
    path.join(workDir, '.github', 'instructions', 'sample.instructions.md'),
    `---\napplyTo: '${glob}'\n---\n\n${body}`,
    'utf8',
  );

  if (options?.orphanAdapter === true) {
    writeFileSync(
      path.join(workDir, '.github', 'instructions', 'orphan.instructions.md'),
      "---\napplyTo: 'packages/core/src/**'\n---\n\nOrphan.\n",
      'utf8',
    );
  }
}

describe('the path-scoped rule gate', () => {
  it('accepts the repository as it stands', async () => {
    expect(await main(['--check', '--root', REPO_ROOT])).toBe(0);
  });

  it('accepts a tree whose adapters match their canonical rule', async () => {
    writeTree();
    expect(await findProblems(workDir)).toEqual([]);
  });

  it('rejects a rule whose path matches no file', async () => {
    // A glob that matches nothing is a silent hole: the rule looks present
    // and never fires.
    writeTree({ glob: 'packages/does-not-exist/**' });
    const problems = await findProblems(workDir);
    expect(problems.join('\n')).toMatch(/matches no file/);
    expect(await main(['--check', '--root', workDir])).toBe(1);
  });

  it('rejects an adapter that was hand-edited away from its canonical rule', async () => {
    writeTree({ adapterBody: '# Sample rule\n\nAn adapter somebody edited by hand.\n' });
    const problems = await findProblems(workDir);
    expect(problems.join('\n')).toMatch(/does not match its canonical rule/);
    expect(await main(['--check', '--root', workDir])).toBe(1);
  });

  it('rejects a canonical rule with no name in its frontmatter', async () => {
    writeTree({ omitName: true });
    await expect(main(['--check', '--root', workDir])).rejects.toThrow(/name/);
  });

  it('rejects an adapter that has no canonical rule behind it', async () => {
    writeTree({ orphanAdapter: true });
    const problems = await findProblems(workDir);
    expect(problems.join('\n')).toMatch(/has no canonical rule/);
    expect(await main(['--check', '--root', workDir])).toBe(1);
  });
});
