import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Agent-surface enforcement: the repository ships its skills in one canonical,
 * provider-neutral place (`.agents/skills/<name>/SKILL.md`) and every agent
 * runtime reaches them through a relative symlink in its own provider
 * directory.
 *
 * Delegates to scripts/check-agent-surface.mjs, which fails closed on a
 * missing canonical file, broken frontmatter, a provider entry that is not a
 * symlink in the git index, a symlink with the wrong target, a symlink that
 * does not resolve, a canonical skill with no provider symlink, or a skill
 * body that still names a vendor path or document.
 */
vi.setConfig({ testTimeout: 60_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-agent-surface.mjs');

const SKILL_NAME = 'demo-skill';

const VALID_SKILL = `---
name: ${SKILL_NAME}
description: Use when a fixture needs a canonical skill to exercise the agent surface guard.
---

# Skill: Demo

Fixture body.
`;

const fixtureRoots: string[] = [];

function runCheck(root?: string) {
  const args = root ? [scriptPath, '--root', root] : [scriptPath];
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
}

/**
 * The guard reads the GIT INDEX MODE (`git ls-files -s`), so a fixture has to
 * be a real git repository. This is a throwaway repo inside a temp directory:
 * the project's own git index is never touched.
 */
function git(root: string, args: string[]) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function createFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-surface-'));
  fixtureRoots.push(root);

  const canonical = path.join(root, '.agents', 'skills', SKILL_NAME);
  mkdirSync(canonical, { recursive: true });
  writeFileSync(path.join(canonical, 'SKILL.md'), VALID_SKILL, 'utf8');

  for (const providerDir of ['.claude', '.github']) {
    const skillsDir = path.join(root, providerDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(`../../.agents/skills/${SKILL_NAME}`, path.join(skillsDir, SKILL_NAME), 'dir');
  }

  git(root, ['init', '--quiet']);
  git(root, ['add', '-A']);
  return root;
}

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('agent surface enforcement', () => {
  it('passes on the repository', () => {
    const result = runCheck();
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: agent surface consistent');
  });

  it('passes on a canonical skill with valid provider symlinks', () => {
    const root = createFixture();
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: agent surface consistent');
  });

  it('fails when a provider entry is not a symlink in the git index', () => {
    const root = createFixture();
    const linkPath = path.join(root, '.github', 'skills', SKILL_NAME);
    unlinkSync(linkPath);
    writeFileSync(linkPath, 'not a symlink\n', 'utf8');
    git(root, ['add', '-A']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('120000');
  });

  it('fails when a provider entry is a real directory with tracked content', () => {
    const root = createFixture();
    const linkPath = path.join(root, '.github', 'skills', SKILL_NAME);
    unlinkSync(linkPath);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(path.join(linkPath, 'SKILL.md'), VALID_SKILL, 'utf8');
    git(root, ['add', '-A']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('is not a symlink');
  });

  it('fails when a provider symlink points at the wrong target', () => {
    const root = createFixture();
    const linkPath = path.join(root, '.claude', 'skills', SKILL_NAME);
    unlinkSync(linkPath);
    symlinkSync(`../.agents/skills/${SKILL_NAME}`, linkPath, 'dir');
    git(root, ['add', '-A']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('points at');
  });

  it('fails when a canonical skill has no SKILL.md', () => {
    const root = createFixture();
    rmSync(path.join(root, '.agents', 'skills', SKILL_NAME, 'SKILL.md'), { force: true });
    git(root, ['add', '-A']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('missing');
  });

  it('fails when the frontmatter has no description', () => {
    const root = createFixture();
    const skillFile = path.join(root, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
    writeFileSync(skillFile, `---\nname: ${SKILL_NAME}\n---\n\n# Skill: Demo\n`, 'utf8');
    git(root, ['add', '-A']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('missing "description"');
  });

  it('fails when the frontmatter name does not equal the directory name', () => {
    const root = createFixture();
    const skillFile = path.join(root, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
    writeFileSync(
      skillFile,
      `---\nname: other-name\ndescription: Use when a fixture breaks the name convention.\n---\n\n# Skill: Demo\n`,
      'utf8',
    );
    git(root, ['add', '-A']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('does not equal the directory name');
  });

  it('fails when a skill body still names a vendor document', () => {
    const root = createFixture();
    const skillFile = path.join(root, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
    writeFileSync(
      skillFile,
      `---\nname: ${SKILL_NAME}\ndescription: Use when a fixture keeps a stale vendor reference.\n---\n\n# Skill: Demo\n\nSee .github/copilot-instructions.md for details.\n`,
      'utf8',
    );
    git(root, ['add', '-A']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('vendor path or document');
  });

  it('fails when a canonical skill has no provider symlink', () => {
    const root = createFixture();
    unlinkSync(path.join(root, '.github', 'skills', SKILL_NAME));
    git(root, ['add', '-A']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('no provider symlink');
  });
});
