#!/usr/bin/env node
/**
 * Agent-surface guard.
 *
 * The repository ships its skills in ONE canonical, provider-neutral place
 * (`.agents/skills/<name>/SKILL.md`). Every agent runtime reaches them through
 * a RELATIVE symlink in its own provider directory (`.claude/skills/<name>`,
 * `.github/skills/<name>`), so no vendor directory convention is load-bearing.
 *
 * The check fails closed. It exits non-zero, naming every problem, when:
 *
 *   a. a canonical skill under `.agents/skills/` has no `SKILL.md`;
 *   b. a canonical skill's frontmatter has no `name` / `description`, the
 *      `name` does not equal the directory name, or the `description` is
 *      longer than 1024 characters;
 *   c. a tracked entry under `.claude/skills/` or `.github/skills/` is not a
 *      symlink. The GIT INDEX MODE decides this (`git ls-files -s`): a symlink
 *      is mode `120000`, a regular file is `100644`. The filesystem alone is
 *      not enough, because the index is what gets committed;
 *   c2. a provider entry exists on disk but is NOT in the index. The committed
 *      shape of an unstaged symlink is unknown, so the check fails closed
 *      rather than let it reach another developer unstaged;
 *   c3. the git index cannot be read at all, while there are provider entries
 *      to check. The guard says so instead of degrading into a weaker check;
 *   d. such a symlink does not point at exactly `../../.agents/skills/<name>`;
 *   e. such a symlink does not resolve to an existing canonical skill directory;
 *   f. a canonical skill has no provider symlink in `.claude/skills/` and/or
 *      `.github/skills/`;
 *   g. a skill body still references a vendor path or vendor document.
 *
 * Speckit skills are ignored everywhere: they are the maintainer's personal
 * spec-kit flow, globally git-ignored, and never part of the canonical set.
 *
 * The agent ROLES work the same way. The canonical role lives in
 * `.agents/agents/<role>.md` and carries a provider-neutral `tools:` list; the
 * two provider adapters (`.claude/agents/<role>.md` and
 * `.github/agents/<role>.agent.md`) are generated from it by
 * `scripts/generate-agent-surface.ts`, because the two runtimes name their
 * tools differently. The check fails closed, naming every problem, when:
 *
 *   h. a canonical role has no frontmatter carrying `name`, `description` and
 *      `role`, or its `role` does not equal the file name;
 *   i. a canonical role names a tool outside the neutral vocabulary
 *      (read, write, edit, execute, search, web, agent);
 *   j. a provider adapter is not what the generator produces;
 *   k. a provider adapter has no canonical role behind it;
 *   l. a canonical role has no provider adapter in one of the two provider
 *      directories.
 *
 * Run: `pnpm exec tsx scripts/check-agent-surface.mjs` (repo root).
 * `--root <dir>` runs the same checks against another tree (used by the test).
 *
 * The role checks reuse the generator, so the gate and the generator can never
 * disagree about what an adapter looks like. That import needs a runtime that
 * strips TypeScript types (Node 22.18+ or 24+).
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRoles, findProblems as findRoleProblems } from './generate-agent-surface.ts';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANONICAL_DIR = '.agents/skills';
const PROVIDER_DIRS = ['.claude/skills', '.github/skills'];
const MAX_DESCRIPTION_LENGTH = 1024;
const SPECKIT_PREFIX = 'speckit-';

/**
 * Vendor references a skill body must not contain any more. The provider
 * directories themselves stay legal (create-skill has to teach where the
 * symlinks live), but a body may not point at skill CONTENT inside a
 * provider directory, nor at a vendor instruction document.
 */
const VENDOR_BODY_PATTERNS = [
  { label: 'copilot-instructions.md', re: /copilot-instructions\.md/ },
  { label: 'CLAUDE.md', re: /CLAUDE\.md/ },
  { label: '.claude/skills/<name>', re: /\.claude\/skills\/[A-Za-z0-9._-]+/ },
  { label: '.github/skills/<name>', re: /\.github\/skills\/[A-Za-z0-9._-]+/ },
  { label: '.claude/skills/<name>/SKILL.md', re: /\.claude\/skills\/[^\s`'")/]+\/SKILL\.md/ },
  { label: '.github/skills/<name>/SKILL.md', re: /\.github\/skills\/[^\s`'")/]+\/SKILL\.md/ },
];

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  if (index !== -1 && argv[index + 1]) {
    return path.resolve(argv[index + 1]);
  }
  return DEFAULT_ROOT;
}

function isSpeckit(name) {
  return name.startsWith(SPECKIT_PREFIX);
}

function expectedTarget(name) {
  return `../../.agents/skills/${name}`;
}

function listDirectory(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Parse the leading `---` frontmatter block. Returns the raw field map or a
 * failure reason; the block must expose `name` and `description`.
 */
function parseFrontmatter(content) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) {
    return { ok: false, reason: 'missing YAML frontmatter block' };
  }
  const fields = new Map();
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const field = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].trim());
  }
  return { ok: true, fields };
}

/** `git ls-files -s` output: `<mode> <object> <stage>\t<path>` */
function readIndex(root) {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '-s', '--', ...PROVIDER_DIRS],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return { available: false, entries: new Map() };
  }
  const entries = new Map();
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [meta, filePath] = line.split('\t');
    if (!meta || !filePath) continue;
    const [mode, object] = meta.split(/\s+/);
    entries.set(filePath, { mode, object });
  }
  return { available: true, entries };
}

/** The tracked content of a symlink entry is its target path. */
function readBlob(root, object) {
  const result = spawnSync('git', ['-C', root, 'cat-file', 'blob', object], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout ?? null;
}

function checkCanonicalSkills(root, failures) {
  const canonicalRoot = path.join(root, CANONICAL_DIR);
  const names = listDirectory(canonicalRoot)
    .filter((name) => !isSpeckit(name))
    .sort();
  const skills = [];

  for (const name of names) {
    const dir = path.join(canonicalRoot, name);
    const skillFile = path.join(dir, 'SKILL.md');

    let stat = null;
    try {
      stat = lstatSync(dir);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      failures.push(`canonical skill "${name}" is not a directory under ${CANONICAL_DIR}/`);
      continue;
    }

    let content = null;
    try {
      content = readFileSync(skillFile, 'utf8');
    } catch {
      content = null;
    }
    if (content === null) {
      failures.push(`canonical skill "${name}" is missing ${CANONICAL_DIR}/${name}/SKILL.md`);
      continue;
    }

    const frontmatter = parseFrontmatter(content);
    if (!frontmatter.ok) {
      failures.push(`canonical skill "${name}": ${frontmatter.reason} (need name and description)`);
      continue;
    }
    const fields = frontmatter.fields ?? new Map();
    const frontName = fields.get('name');
    const description = fields.get('description');

    if (!frontName) {
      failures.push(`canonical skill "${name}": frontmatter is missing "name"`);
    } else if (frontName !== name) {
      failures.push(
        `canonical skill "${name}": frontmatter name "${frontName}" does not equal the directory name`,
      );
    }
    if (description === undefined || description === '') {
      failures.push(`canonical skill "${name}": frontmatter is missing "description"`);
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      failures.push(
        `canonical skill "${name}": frontmatter description is ${description.length} characters (max ${MAX_DESCRIPTION_LENGTH})`,
      );
    }

    const body = content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
    for (const pattern of VENDOR_BODY_PATTERNS) {
      if (pattern.re.test(body)) {
        failures.push(
          `canonical skill "${name}": body still references the vendor path or document "${pattern.label}"`,
        );
      }
    }

    skills.push(name);
  }

  return skills;
}

/**
 * (c) The committed shape of a provider entry: the entry itself must be a
 * symlink (git mode 120000). Anything nested inside a provider skill
 * directory means the provider entry is a real directory, not a symlink.
 */
function checkIndexShape(index, failures) {
  for (const [filePath, entry] of index.entries) {
    const parts = filePath.split('/');
    if (parts.length < 3) continue;
    const providerDir = `${parts[0]}/${parts[1]}`;
    if (!PROVIDER_DIRS.includes(providerDir)) continue;
    const name = parts[2];
    if (isSpeckit(name)) continue;
    if (parts.length > 3) {
      failures.push(
        `${filePath} is tracked with git mode ${entry.mode} inside ${providerDir}/${name}, expected ${providerDir}/${name} itself to be a 120000 symlink`,
      );
    }
  }
}

function checkProviderDirs(root, index, failures) {
  let providerEntries = 0;
  for (const providerDir of PROVIDER_DIRS) {
    const providerRoot = path.join(root, providerDir);
    const names = listDirectory(providerRoot)
      .filter((name) => !isSpeckit(name))
      .sort();

    providerEntries += names.length;

    for (const name of names) {
      const linkPath = path.join(providerRoot, name);
      const relative = `${providerDir}/${name}`;

      // (c) the committed shape of the entry: a symlink, never a real file.
      const entry = index.available ? index.entries.get(relative) : undefined;
      if (index.available && entry === undefined) {
        // The path is on disk but the index does not know it. The committed
        // shape is therefore unknown, and the index is what gets committed.
        // Failing closed here is what catches a symlink that was added and
        // never staged: without it, the entry would reach every other
        // developer as whatever the filesystem gave them.
        failures.push(
          `${relative} is not tracked in git, stage it so it is committed as a symlink`,
        );
      } else if (entry !== undefined && entry.mode !== '120000') {
        failures.push(
          `${relative} is tracked with git mode ${entry.mode}, expected 120000 (symlink)`,
        );
      }

      let stat = null;
      try {
        stat = lstatSync(linkPath);
      } catch {
        stat = null;
      }
      if (!stat) {
        failures.push(`${relative} does not exist`);
        continue;
      }
      if (!stat.isSymbolicLink()) {
        failures.push(`${relative} is not a symlink`);
        continue;
      }

      // (d) the target must be exactly `../../.agents/skills/<name>`.
      const target = expectedTarget(name);
      const linkTarget = readLink(linkPath);
      if (linkTarget !== target) {
        failures.push(`${relative} points at "${linkTarget}", expected "${target}"`);
      }
      if (entry && entry.mode === '120000') {
        const tracked = readBlob(root, entry.object);
        if (tracked !== null && tracked.replace(/\r?\n$/, '') !== target) {
          failures.push(
            `${relative} is tracked pointing at "${tracked.replace(/\r?\n$/, '')}", expected "${target}"`,
          );
        }
      }

      // (e) the symlink must resolve to an existing canonical skill directory.
      const canonicalDir = path.join(root, CANONICAL_DIR, name);
      let resolved = null;
      try {
        resolved = realpathSync(linkPath);
      } catch {
        resolved = null;
      }
      if (!resolved) {
        failures.push(`${relative} does not resolve to an existing directory`);
      } else if (!resolved.startsWith(realpathOf(path.join(root, CANONICAL_DIR)) + path.sep)) {
        failures.push(`${relative} resolves outside ${CANONICAL_DIR}/ (${resolved})`);
      } else if (!existsDirectory(canonicalDir)) {
        failures.push(`${relative} resolves to a missing canonical skill ${CANONICAL_DIR}/${name}`);
      }
    }
  }

  if (!index.available && providerEntries > 0) {
    // The index is what gets committed, so a check that cannot read it cannot
    // say anything about the committed shape of the provider entries. Failing
    // closed keeps the guard from silently degrading into a weaker check.
    failures.push(
      'the git index could not be read, so the committed shape of the provider entries is unverified',
    );
  }
}

function readLink(linkPath) {
  try {
    return readlinkSync(linkPath);
  } catch {
    return null;
  }
}

function realpathOf(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function existsDirectory(target) {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function checkProviderCoverage(root, skills, failures) {
  for (const name of skills) {
    for (const providerDir of PROVIDER_DIRS) {
      const linkPath = path.join(root, providerDir, name);
      let stat = null;
      try {
        stat = lstatSync(linkPath);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isSymbolicLink()) {
        failures.push(
          `canonical skill "${name}" has no provider symlink in ${providerDir}/ (expected a symlink to ${expectedTarget(name)})`,
        );
      }
    }
  }
}

/**
 * (h)-(l) The agent roles: the canonical role under `.agents/agents/`, its
 * frontmatter, the neutral tool vocabulary, and the two generated provider
 * adapters. The generator owns the rendering, so the gate only has to ask it
 * what is wrong.
 */
function checkAgentRoles(root, failures) {
  for (const problem of findRoleProblems(root)) {
    failures.push(problem.message);
  }
  return collectRoles(root).roles.length;
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  const failures = [];
  const index = readIndex(root);

  const skills = checkCanonicalSkills(root, failures);
  checkIndexShape(index, failures);
  checkProviderDirs(root, index, failures);
  checkProviderCoverage(root, skills, failures);
  const roles = checkAgentRoles(root, failures);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${failure}`);
    }
    console.error(`agent surface check FAILED: ${failures.length} problem(s) found`);
    process.exit(1);
  }

  console.log(
    `ok: agent surface consistent (${skills.length} canonical skills, ${roles} canonical roles, provider symlinks verified)`,
  );
}

main();
