import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Personal-harness leakage guard (ADR-020, Guard clause): tracked files must
 * carry no material from the maintainer's private agent harness, modeled on
 * the ai-config guard test the portfolio repository runs over its AI
 * configuration. The scanner is a pure function over synthetic inputs so its
 * detections can be proven without touching the tree. The ADR-020 refinement
 * (2026-11-12) lets exactly the project-owned skill surface through: one
 * SKILL.md wrapper per procedure and one relative-symlink adapter per wrapper.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

// The scanner's own source must name the terms it forbids, so its path is
// exempt alongside the ADRs, the migration notes and the changelog that
// legitimately discuss the harness.
const SELF_PATH = path
  .relative(REPO_ROOT, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join('/');

type ScannedFile = { path: string; content: string };

const FORBIDDEN_TERMS = [
  'claude-skills',
  'ai-dev-runtime',
  'model-delegate',
  'cross-runtime',
  'hindsight',
  '/Users/',
  '~/Desktop',
  'routing-reviewer',
  'routing-implementer',
  'routing-validator',
];

// Every term is escaped so path-shaped terms like /Users/ and ~/Desktop match
// literally instead of acting as regular-expression syntax.
const FORBIDDEN_TERMS_PATTERN = new RegExp(
  FORBIDDEN_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g',
);

const EXEMPT_PATH_PREFIXES = ['docs/adr/', 'docs/migration/'];
const EXEMPT_PATHS = new Set(['CHANGELOG.md', SELF_PATH]);

const FORBIDDEN_PATH_PREFIXES = [
  '.claude/',
  '.agents/',
  '.github/agents/',
  '.github/instructions/',
  '.github/skills/',
  '.github/prompts/',
  '.github/hooks/',
];

// The refined project-owned surface: a wrapper is exactly one SKILL.md inside
// a single .agents/skills/<name>/ directory, and an adapter is exactly one
// .claude/skills/<name> entry that is a symlink.
const WRAPPER_SKILL_PATH_PATTERN = /^\.agents\/skills\/[^/]+\/SKILL\.md$/;
const ADAPTER_PATH_PREFIX = '.claude/skills/';

function isExemptPath(filePath: string): boolean {
  if (EXEMPT_PATHS.has(filePath)) return true;
  return EXEMPT_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

// A wrapper path is allowed on its path alone; an adapter path is allowed
// only when it is a symlink (a non-null readlink target). Everything else
// under the forbidden prefixes stays forbidden.
function isForbiddenPath(filePath: string, symlinkTarget: string | null = null): boolean {
  if (WRAPPER_SKILL_PATH_PATTERN.test(filePath)) return false;
  if (
    filePath.startsWith(ADAPTER_PATH_PREFIX) &&
    !filePath.slice(ADAPTER_PATH_PREFIX.length).includes('/') &&
    symlinkTarget !== null
  ) {
    return false;
  }
  return FORBIDDEN_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

// git ls-files names a tracked symlink as a plain path; its target lives on
// disk, so the adapter checks read it back. null means: not a symlink.
function symlinkTargetOf(filePath: string): string | null {
  try {
    return fs.readlinkSync(path.join(REPO_ROOT, filePath));
  } catch {
    return null;
  }
}

// Assertion A (wrapper integrity): every wrapper's pointer must name a
// procedure file that exists in the tracked set.
function findWrapperPointerViolations(
  wrappers: { path: string; content: string }[],
  trackedFiles: string[],
): string[] {
  const tracked = new Set(trackedFiles);
  const violations: string[] = [];
  for (const wrapper of wrappers) {
    const referenced = wrapper.content.match(/docs\/procedures\/[A-Za-z0-9._-]+\.md/g) ?? [];
    const targets = [...new Set(referenced)];
    if (targets.length === 0) {
      violations.push(`${wrapper.path}: no docs/procedures/ pointer`);
      continue;
    }
    for (const target of targets) {
      if (!tracked.has(target)) violations.push(`${wrapper.path}: points at untracked ${target}`);
    }
  }
  return violations;
}

// Assertion B (adapter integrity): every adapter must be a relative symlink
// to ../../.agents/skills/<its own name>, and the wrapper and adapter sets
// must match exactly.
function findAdapterViolations(
  adapters: { name: string; symlinkTarget: string | null }[],
  wrapperNames: string[],
): string[] {
  const violations: string[] = [];
  const adaptersByName = new Map(adapters.map((adapter) => [adapter.name, adapter]));
  for (const adapter of adapters) {
    const expected = `../../.agents/skills/${adapter.name}`;
    if (adapter.symlinkTarget === null) {
      violations.push(`.claude/skills/${adapter.name}: not a symlink`);
    } else if (adapter.symlinkTarget !== expected) {
      violations.push(
        `.claude/skills/${adapter.name}: target ${adapter.symlinkTarget}, expected ${expected}`,
      );
    }
  }
  for (const name of wrapperNames) {
    if (!adaptersByName.has(name)) violations.push(`.agents/skills/${name}: missing adapter`);
  }
  for (const name of adaptersByName.keys()) {
    if (!wrapperNames.includes(name)) {
      violations.push(`.claude/skills/${name}: no matching wrapper`);
    }
  }
  return violations;
}

function findViolations(files: ScannedFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (isExemptPath(file.path)) continue;
    const lines = file.content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const matched = lines[index].match(FORBIDDEN_TERMS_PATTERN);
      if (matched === null) continue;
      for (const term of new Set(matched)) {
        violations.push(`${file.path} line ${index + 1}: forbidden term "${term}"`);
      }
    }
  }
  return violations;
}

// Enumerate the index, never the filesystem: untracked local material stays
// out of scope by construction.
function listTrackedFiles(): string[] {
  const output = execSync('git ls-files -z', { cwd: REPO_ROOT });
  return output.toString('utf-8').split('\0').filter((entry) => entry !== '');
}

// A tracked entry contributes text the scanner can read. A symbolic link
// contributes its target string: reading through a directory adapter would
// raise EISDIR, and the target path is exactly the text worth scanning. The
// adapters themselves are held by their own assertion below.
function readTrackedEntry(filePath: string): string {
  const absolute = path.join(REPO_ROOT, filePath);
  if (fs.lstatSync(absolute).isSymbolicLink()) {
    return fs.readlinkSync(absolute);
  }
  return fs.readFileSync(absolute, 'utf-8');
}

const EXPECTED_CLAUDE_MD = '@AGENTS.md\n';

// The budget only ratchets down. Never raise it without an ADR.
// 370: the documented skill-surface section (ADR-020 refinement, 2026-11-12).
const AGENTS_MD_LINE_BUDGET = 370;

describe('tracked files carry no personal harness material', () => {
  it('finds no forbidden term in any tracked file', () => {
    const tracked = listTrackedFiles();
    expect(tracked.length).toBeGreaterThan(0);
    const scanned = tracked.map((filePath) => ({
      path: filePath,
      content: readTrackedEntry(filePath),
    }));
    const violations = findViolations(scanned);
    expect(
      violations,
      `personal harness material leaked into tracked files:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('tracks only the allowed skill surface under agent-harness directories', () => {
    const offenders = listTrackedFiles().filter((filePath) => {
      // Only the surface prefixes need the on-disk symlink probe.
      const underSurfacePrefix =
        filePath.startsWith('.claude/') || filePath.startsWith('.agents/');
      return isForbiddenPath(filePath, underSurfacePrefix ? symlinkTargetOf(filePath) : null);
    });
    expect(
      offenders,
      `tracked paths under forbidden prefixes:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps every skill wrapper pointing at a tracked procedure file', () => {
    const tracked = listTrackedFiles();
    const wrappers = tracked
      .filter((filePath) => WRAPPER_SKILL_PATH_PATTERN.test(filePath))
      .map((filePath) => ({
        path: filePath,
        content: fs.readFileSync(path.join(REPO_ROOT, filePath), 'utf-8'),
      }));
    const violations = findWrapperPointerViolations(wrappers, tracked);
    expect(
      violations,
      `wrappers with broken procedure pointers:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps every skill adapter an exact relative symlink with a matching wrapper', () => {
    const tracked = listTrackedFiles();
    const adapters = tracked
      .filter(
        (filePath) =>
          filePath.startsWith(ADAPTER_PATH_PREFIX) &&
          !filePath.slice(ADAPTER_PATH_PREFIX.length).includes('/'),
      )
      .map((filePath) => ({
        name: filePath.slice(ADAPTER_PATH_PREFIX.length),
        symlinkTarget: symlinkTargetOf(filePath),
      }));
    const wrapperNames = tracked
      .filter((filePath) => WRAPPER_SKILL_PATH_PATTERN.test(filePath))
      .map((filePath) => filePath.split('/')[2]);
    const violations = findAdapterViolations(adapters, wrapperNames);
    expect(
      violations,
      `adapters violating the symlink contract:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps CLAUDE.md as a pure pointer to AGENTS.md', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe(EXPECTED_CLAUDE_MD);
  });

  it('keeps AGENTS.md within its line-count budget', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const lineCount = content.split('\n').length - 1;
    expect(lineCount).toBeLessThanOrEqual(AGENTS_MD_LINE_BUDGET);
  });
});

// Negative controls: the scanner demonstrably reddens on a planted violation,
// so a green real-tree run means the terms are genuinely absent.
describe('findViolations negative controls', () => {
  it('flags a forbidden term in a non-exempt path with path, line and term', () => {
    const violations = findViolations([
      { path: 'src/example.ts', content: 'const tool = "model-delegate";\n' },
    ]);
    expect(violations).toEqual(['src/example.ts line 1: forbidden term "model-delegate"']);
  });

  it('exempts the same content under docs/adr/', () => {
    const violations = findViolations([
      {
        path: 'docs/adr/020-repository-harness-agnostic.md',
        content: 'const tool = "model-delegate";\n',
      },
    ]);
    expect(violations).toEqual([]);
  });

  it('flags tracked paths under agent-harness directories', () => {
    expect(isForbiddenPath('.claude/settings.json')).toBe(true);
    expect(isForbiddenPath('.github/agents/helper.md')).toBe(true);
    expect(isForbiddenPath('.github/skills/notes/SKILL.md')).toBe(true);
    expect(isForbiddenPath('docs/architecture/legacy-import.md')).toBe(false);
  });

  it('allows exactly the refined skill surface through the path rule', () => {
    expect(isForbiddenPath('.agents/skills/foo/bar.md')).toBe(true); // not a SKILL.md
    expect(isForbiddenPath('.agents/skills/foo/SKILL.md')).toBe(false);
    expect(isForbiddenPath('.agents/skills/foo/SKILL.md', 'irrelevant')).toBe(false);
    expect(isForbiddenPath('.agents/agents/helper.md')).toBe(true);
    expect(isForbiddenPath('.claude/skills/foo')).toBe(true); // regular file, not a symlink
    expect(isForbiddenPath('.claude/skills/foo', '../../.agents/skills/foo')).toBe(false);
    expect(isForbiddenPath('.claude/skills/foo/bar.md', '../../.agents/skills/foo')).toBe(true);
    expect(isForbiddenPath('.claude/commands/run.md')).toBe(true);
  });

  it('flags a wrapper whose procedure pointer is missing from the tracked set', () => {
    const violations = findWrapperPointerViolations(
      [
        {
          path: '.agents/skills/foo/SKILL.md',
          content: 'The full procedure lives at docs/procedures/foo.md.\n',
        },
        {
          path: '.agents/skills/bar/SKILL.md',
          content: 'The full procedure lives at docs/procedures/bar.md.\n',
        },
      ],
      ['docs/procedures/bar.md'],
    );
    expect(violations).toEqual([
      '.agents/skills/foo/SKILL.md: points at untracked docs/procedures/foo.md',
    ]);
  });

  it('flags adapters that are not exact relative symlinks or lack a wrapper', () => {
    const violations = findAdapterViolations(
      [
        { name: 'regular-file', symlinkTarget: null },
        { name: 'wrong-target', symlinkTarget: 'elsewhere' },
        { name: 'orphan', symlinkTarget: '../../.agents/skills/orphan' },
      ],
      ['regular-file', 'wrong-target', 'search'],
    );
    expect(violations).toEqual([
      '.claude/skills/regular-file: not a symlink',
      '.claude/skills/wrong-target: target elsewhere, expected ../../.agents/skills/wrong-target',
      '.agents/skills/search: missing adapter',
      '.claude/skills/orphan: no matching wrapper',
    ]);
  });

  it('passes a clean wrapper and its matching adapter', () => {
    const pointerViolations = findWrapperPointerViolations(
      [
        {
          path: '.agents/skills/search/SKILL.md',
          content: 'The full procedure lives at docs/procedures/search.md.\n',
        },
      ],
      ['docs/procedures/search.md'],
    );
    expect(pointerViolations).toEqual([]);
    const adapterViolations = findAdapterViolations(
      [{ name: 'search', symlinkTarget: '../../.agents/skills/search' }],
      ['search'],
    );
    expect(adapterViolations).toEqual([]);
  });

  it('passes a clean file', () => {
    const violations = findViolations([
      { path: 'src/clean.ts', content: 'export const answer = 42;\n' },
    ]);
    expect(violations).toEqual([]);
  });

  it('exempts its own source, which must name the terms it forbids', () => {
    const violations = findViolations([
      {
        path: SELF_PATH,
        content: fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8'),
      },
    ]);
    expect(violations).toEqual([]);
  });
});
