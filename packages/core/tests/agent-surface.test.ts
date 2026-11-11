import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Agent-surface enforcement: the repository ships its skills in one canonical,
 * provider-neutral place (`.agents/skills/<name>/SKILL.md`) and every agent
 * runtime reaches them through a relative symlink in its own provider
 * directory. The agent ROLES are the same idea one level up: the canonical
 * role lives in `.agents/agents/<role>.md` and the two provider adapters
 * (`.claude/agents/<role>.md`, `.github/agents/<role>.agent.md`) are generated
 * from it, because the two runtimes name their tools differently.
 *
 * Delegates to scripts/check-agent-surface.mjs, which fails closed on a
 * missing canonical file, broken frontmatter, a provider entry that is not a
 * symlink in the git index, a symlink with the wrong target, a symlink that
 * does not resolve, a canonical skill with no provider symlink, a skill body
 * that still names a vendor path or document, a canonical role with no
 * frontmatter, a role whose tools leave the neutral vocabulary, a provider
 * adapter that does not match the generated one, an adapter with no canonical
 * role behind it, and a canonical role with no provider adapter.
 */
vi.setConfig({ testTimeout: 120_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-agent-surface.mjs');
const generatorPath = path.join(repoRoot, 'scripts', 'generate-agent-surface.ts');
/**
 * The guard imports the TypeScript generator, and the generator is TypeScript
 * itself, so both need a runtime that strips the types. The repo's runner for
 * that is tsx, so the fixture spawns it through Node. Going through Node rather
 * than the `tsx` shim keeps the spawn free of a shell, so it behaves the same
 * on every platform.
 */
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const SKILL_NAME = 'demo-skill';

const VALID_SKILL = `---
name: ${SKILL_NAME}
description: Use when a fixture needs a canonical skill to exercise the agent surface guard.
---

# Skill: Demo

Fixture body.
`;

const fixtureRoots: string[] = [];

const ROLE_NAME = 'demo-role';

const VALID_ROLE = `---
name: Demo Role
description: Use when a fixture needs a canonical role to exercise the agent surface guard.
role: ${ROLE_NAME}
tools:
  - read
  - execute
---

# Role: Demo

Fixture body.
`;

function runCheck(root?: string) {
  const args = root ? [scriptPath, '--root', root] : [scriptPath];
  return spawnSync(process.execPath, [tsxCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

/**
 * Runs the generator against a tree. The generator is a TypeScript file, so it
 * needs a runtime that strips the types; tsx is that runtime.
 */
function runGenerator(root: string) {
  return spawnSync(process.execPath, [tsxCli, generatorPath, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
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

/**
 * A role fixture is a plain tree: the role checks read the filesystem and the
 * generator, never the git index, so no git repository is needed here.
 */
function createRoleFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-roles-'));
  fixtureRoots.push(root);

  const canonical = path.join(root, '.agents', 'agents');
  mkdirSync(canonical, { recursive: true });
  writeFileSync(path.join(canonical, `${ROLE_NAME}.md`), VALID_ROLE, 'utf8');

  const generated = runGenerator(root);
  if (generated.status !== 0) {
    throw new Error(`the generator failed: ${generated.stderr}`);
  }
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

  it('fails when a provider symlink was added but never staged', () => {
    const root = createFixture();
    // A second skill, present on disk, absent from the index. The filesystem
    // check passes and the committed shape is unknown, so the guard must fail
    // rather than let it reach another developer as an unstaged artifact.
    const canonical = path.join(root, '.agents', 'skills', 'unstaged-skill');
    mkdirSync(canonical, { recursive: true });
    writeFileSync(
      path.join(canonical, 'SKILL.md'),
      VALID_SKILL.replace(SKILL_NAME, 'unstaged-skill'),
      'utf8',
    );
    for (const providerDir of ['.claude', '.github']) {
      symlinkSync(
        '../../.agents/skills/unstaged-skill',
        path.join(root, providerDir, 'skills', 'unstaged-skill'),
        'dir',
      );
    }
    git(root, ['add', '.agents']);

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('is not tracked in git');
  });

  it('fails when the git index cannot be read', () => {
    const root = createFixture();
    // A tree that is not a git repository: `git ls-files` fails, so the guard
    // cannot say anything about the committed shape and must say so.
    rmSync(path.join(root, '.git'), { recursive: true, force: true });

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('git index could not be read');
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

describe('agent role surface enforcement', () => {
  it('passes on a canonical role with generated provider adapters', () => {
    const root = createRoleFixture();
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: agent surface consistent');
  });

  it('fails when a canonical role has no name in its frontmatter', () => {
    const root = createRoleFixture();
    const canonical = path.join(root, '.agents', 'agents', `${ROLE_NAME}.md`);
    writeFileSync(canonical, VALID_ROLE.replace('name: Demo Role\n', ''), 'utf8');

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('missing "name"');
  });

  it('fails when a provider adapter was edited by hand', () => {
    const root = createRoleFixture();
    const adapter = path.join(root, '.claude', 'agents', `${ROLE_NAME}.md`);
    writeFileSync(adapter, `${readFileSync(adapter, 'utf8')}\nhand edited\n`, 'utf8');

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('does not match the generated adapter');
  });

  it('fails when a provider adapter has no canonical role behind it', () => {
    const root = createRoleFixture();
    writeFileSync(
      path.join(root, '.github', 'agents', 'orphan.agent.md'),
      '---\nname: Orphan\n---\n\nOrphan body.\n',
      'utf8',
    );

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('has no canonical role');
  });

  it('fails when a canonical role names a tool outside the neutral vocabulary', () => {
    const root = createRoleFixture();
    const canonical = path.join(root, '.agents', 'agents', `${ROLE_NAME}.md`);
    writeFileSync(canonical, VALID_ROLE.replace('  - execute', '  - Bash'), 'utf8');

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('outside the neutral vocabulary');
  });

  it('fails when a canonical role has no provider adapter', () => {
    const root = createRoleFixture();
    rmSync(path.join(root, '.github', 'agents', `${ROLE_NAME}.agent.md`), { force: true });

    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('has no provider adapter');
  });
});
