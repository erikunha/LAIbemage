/**
 * Generates the provider adapters of the agent roles from the canonical
 * sources under `.agents/agents/`.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-agent-surface.ts            -- write the adapters
 *   pnpm exec tsx scripts/generate-agent-surface.ts --check    -- exit 1 if an adapter is out of date
 *
 * The two runtimes read different vocabularies. Claude Code names its tools
 * `Read`, `Bash`, `Grep`; GitHub Copilot names them `read/readFile`,
 * `execute/runInTerminal`, `search/codebase`. A file carrying both sets might
 * be rejected by one of them, so the repository keeps ONE canonical role per
 * agent, with a provider-neutral `tools:` list, and generates one adapter per
 * runtime from it.
 *
 * The model a runtime uses is a property of the runtime, not of the role, so
 * the mapping lives here and the canonical file does not name a vendor model.
 *
 * The generator never writes into `.agents/agents/`: that directory is the
 * source, not a target.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const ROOT = path.resolve(SCRIPT_DIR, '..');

const CANONICAL_DIR = '.agents/agents';
const CLAUDE_DIR = '.claude/agents';
const COPILOT_DIR = '.github/agents';

/**
 * The speckit agents are the maintainer's personal spec-kit flow. They are
 * not tracked and are not part of the canonical roster, so they are ignored
 * everywhere (the same rule the skill guard applies).
 */
const SPECKIT_PREFIX = 'speckit';

/**
 * The provider-neutral tool vocabulary. A canonical role may name nothing
 * else. The order is also the order the adapters list their tools in.
 */
export const NEUTRAL_TOOLS = [
  'read',
  'write',
  'edit',
  'execute',
  'search',
  'web',
  'agent',
] as const;

export type NeutralTool = (typeof NEUTRAL_TOOLS)[number];

/** Claude Code tool names, per neutral tool. */
const CLAUDE_TOOLS: Readonly<Record<NeutralTool, readonly string[]>> = {
  read: ['Read'],
  write: ['Write'],
  edit: ['Edit'],
  execute: ['Bash'],
  search: ['Grep', 'Glob'],
  web: ['WebSearch'],
  agent: ['Task'],
};

/** GitHub Copilot tool names, per neutral tool. */
const COPILOT_TOOLS: Readonly<Record<NeutralTool, readonly string[]>> = {
  read: ['read/readFile'],
  write: ['edit/editFiles'],
  edit: ['edit/editFiles'],
  execute: ['execute/runInTerminal'],
  search: ['search/codebase', 'search/textSearch', 'search/fileSearch'],
  web: ['web/fetch'],
  agent: ['agent'],
};

const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6';
const COPILOT_DEFAULT_MODEL = 'gpt-4o';

/** The roles that do not use the default model of their runtime. */
const CLAUDE_MODELS: Readonly<Record<string, string>> = {
  explore: 'claude-haiku-4-5-20251001',
};

const COPILOT_MODELS: Readonly<Record<string, string>> = {
  'data-integrity': 'claude-opus-4-7',
  'incident-responder': 'claude-opus-4-7',
  'migration-engineer': 'claude-opus-4-7',
  'performance-profiler': 'claude-opus-4-7',
  'refactoring-guardian': 'claude-opus-4-7',
  'security-auditor': 'claude-opus-4-7',
};

export interface Role {
  /** The display name both runtimes show. */
  readonly name: string;
  /** The one-line description both runtimes show. */
  readonly description: string;
  /** The kebab-case role name, which is also the canonical file name. */
  readonly role: string;
  /** The provider-neutral tools of the role. */
  readonly tools: readonly string[];
  /** The role body, verbatim, starting with the blank line after the frontmatter. */
  readonly body: string;
  /** The raw frontmatter block of the optional `argument-hint` key. */
  readonly argumentHint: readonly string[] | undefined;
  /** The raw frontmatter block of the optional `agents` key. */
  readonly agents: readonly string[] | undefined;
  /** The raw frontmatter block of the optional `handoffs` key. */
  readonly handoffs: readonly string[] | undefined;
}

export interface GeneratedFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface RoleProblem {
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** The file the problem is about, relative to the root. */
  readonly relativePath?: string;
  /** What the file should contain, when the generator knows. */
  readonly expected?: string;
}

interface FrontmatterBlock {
  readonly key: string;
  readonly lines: string[];
}

function splitFrontmatter(content: string): { frontmatter: string[]; body: string } | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      end = index;
      break;
    }
  }
  if (end === -1) return null;
  return { frontmatter: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

/**
 * Splits a frontmatter block into its top-level keys. A key starts at column
 * zero; every line that follows it belongs to it, until the next key.
 */
function topLevelBlocks(lines: readonly string[]): FrontmatterBlock[] {
  const blocks: FrontmatterBlock[] = [];
  for (const line of lines) {
    const key = /^([A-Za-z0-9_-]+):/.exec(line);
    if (key !== null) {
      blocks.push({ key: key[1] as string, lines: [line] });
      continue;
    }
    const current = blocks[blocks.length - 1];
    if (current === undefined) continue;
    current.lines.push(line);
  }
  return blocks;
}

function scalarOf(block: FrontmatterBlock | undefined): string | undefined {
  if (block === undefined) return undefined;
  const value = (block.lines[0] ?? '').split(':', 2)[1];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function listItemsOf(block: FrontmatterBlock | undefined): string[] {
  if (block === undefined) return [];
  const items: string[] = [];
  for (const line of block.lines.slice(1)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item !== null) items.push((item[1] ?? '').trim());
  }
  return items;
}

/**
 * A plain YAML scalar: no key separator, no comment, no leading indicator.
 * The canonical file and both adapters quote the same way, so a description
 * that is not plain-safe would be a silent difference between them.
 */
function isPlainScalar(value: string): boolean {
  if (value === '') return false;
  if (value.includes(': ') || value.endsWith(':')) return false;
  if (value.includes(' #')) return false;
  if ('>|&*!%@`\'"'.includes(value[0] as string)) return false;
  return true;
}

/**
 * Parses one canonical role file.
 */
export function parseRole(content: string, file: string): { role: Role } | { error: string } {
  const split = splitFrontmatter(content);
  if (split === null) {
    return { error: `${file} has no YAML frontmatter block` };
  }
  const blocks = topLevelBlocks(split.frontmatter);
  const byKey = new Map(blocks.map((block) => [block.key, block]));

  const name = scalarOf(byKey.get('name'));
  if (name === undefined) return { error: `${file}: frontmatter is missing "name"` };

  const description = scalarOf(byKey.get('description'));
  if (description === undefined) return { error: `${file}: frontmatter is missing "description"` };
  if (!isPlainScalar(description)) {
    return { error: `${file}: the "description" is not a plain YAML scalar` };
  }

  const role = scalarOf(byKey.get('role'));
  if (role === undefined) return { error: `${file}: frontmatter is missing "role"` };

  const tools = listItemsOf(byKey.get('tools'));
  if (tools.length === 0) return { error: `${file}: frontmatter has no "tools" list` };

  return {
    role: {
      name,
      description,
      role,
      tools,
      body: split.body,
      argumentHint: byKey.get('argument-hint')?.lines,
      agents: byKey.get('agents')?.lines,
      handoffs: byKey.get('handoffs')?.lines,
    },
  };
}

export function claudeModel(role: string): string {
  return CLAUDE_MODELS[role] ?? CLAUDE_DEFAULT_MODEL;
}

export function copilotModel(role: string): string {
  return COPILOT_MODELS[role] ?? COPILOT_DEFAULT_MODEL;
}

/**
 * The provider tool names of a neutral tool list, in the vocabulary order and
 * without duplicates (`write` and `edit` share one Copilot tool).
 */
export function providerTools(
  tools: readonly string[],
  table: Readonly<Record<NeutralTool, readonly string[]>>,
): string[] {
  const names: string[] = [];
  for (const neutral of NEUTRAL_TOOLS) {
    if (!tools.includes(neutral)) continue;
    for (const name of table[neutral]) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The Claude Code adapter: the frontmatter keys Claude Code reads, then the
 * role body.
 */
export function renderClaude(role: Role): string {
  const lines = [
    '---',
    `name: ${role.name}`,
    `description: ${role.description}`,
    `model: ${claudeModel(role.role)}`,
    'tools:',
    ...providerTools(role.tools, CLAUDE_TOOLS).map((tool) => `  - ${tool}`),
    '---',
  ];
  return `${lines.join('\n')}\n${role.body}`;
}

/**
 * The GitHub Copilot adapter: the frontmatter keys Copilot reads, plus the
 * Copilot-only metadata the canonical role carries, then the role body.
 */
export function renderCopilot(role: Role): string {
  const lines = [
    '---',
    `name: ${role.name}`,
    `description: ${role.description}`,
    `model: ${copilotModel(role.role)}`,
    'tools:',
    ...providerTools(role.tools, COPILOT_TOOLS).map((tool) => `  - ${tool}`),
  ];
  if (role.argumentHint !== undefined) lines.push(...role.argumentHint);
  if (role.agents !== undefined) lines.push(...role.agents);
  if (role.handoffs !== undefined) lines.push(...role.handoffs);
  lines.push('---');
  return `${lines.join('\n')}\n${role.body}`;
}

/**
 * The adapters the canonical roles produce.
 */
export function expectedFiles(roles: readonly Role[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const role of roles) {
    files.push({
      relativePath: path.posix.join(CLAUDE_DIR, `${role.role}.md`),
      content: renderClaude(role),
    });
    files.push({
      relativePath: path.posix.join(COPILOT_DIR, `${role.role}.agent.md`),
      content: renderCopilot(role),
    });
  }
  return files;
}

/**
 * The canonical roles of the repository, read from `.agents/agents/`.
 */
export function collectRoles(root: string): { roles: Role[]; problems: RoleProblem[] } {
  const problems: RoleProblem[] = [];
  const roles: Role[] = [];
  const directory = path.join(root, CANONICAL_DIR);

  let entries: string[] = [];
  try {
    entries = readdirSync(directory).filter((name) => name.endsWith('.md')).sort();
  } catch {
    // No canonical directory is not a problem of its own: the skill guard
    // treats a missing canonical directory the same way. An adapter without a
    // canonical role behind it is reported below.
    return { roles, problems };
  }

  for (const entry of entries) {
    const relativePath = path.posix.join(CANONICAL_DIR, entry);
    const content = readFileSync(path.join(directory, entry), 'utf8');
    const parsed = parseRole(content, relativePath);
    if ('error' in parsed) {
      problems.push({ message: parsed.error, relativePath });
      continue;
    }
    const role = parsed.role;
    const fileName = entry.replace(/\.md$/, '');
    if (role.role !== fileName) {
      problems.push({
        message: `canonical role "${fileName}": frontmatter role "${role.role}" does not equal the file name`,
        relativePath,
      });
      continue;
    }
    for (const tool of role.tools) {
      if (!(NEUTRAL_TOOLS as readonly string[]).includes(tool)) {
        problems.push({
          message:
            `canonical role "${fileName}": tools names "${tool}", which is outside the neutral ` +
            `vocabulary (${NEUTRAL_TOOLS.join(', ')})`,
          relativePath,
        });
      }
    }
    roles.push(role);
  }

  return { roles, problems };
}

function listProviderFiles(root: string, directory: string, suffix: string): string[] {
  try {
    return readdirSync(path.join(root, directory))
      .filter((name) => name.endsWith(suffix))
      .filter((name) => !name.startsWith(SPECKIT_PREFIX))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every problem the role surface has, in the fail-closed spirit of the skill
 * guard: a canonical role that cannot be parsed, a tool outside the neutral
 * vocabulary, an adapter that does not match what the generator produces, an
 * adapter with no canonical role behind it, and a canonical role with no
 * adapter in one of the provider directories.
 */
export function findProblems(root: string): RoleProblem[] {
  const problems: RoleProblem[] = [];
  const { roles, problems: roleProblems } = collectRoles(root);
  problems.push(...roleProblems);

  const expected = expectedFiles(roles);
  const known = new Set(expected.map((file) => file.relativePath));
  const owner = new Map<string, string>();
  for (const role of roles) {
    owner.set(path.posix.join(CLAUDE_DIR, `${role.role}.md`), role.role);
    owner.set(path.posix.join(COPILOT_DIR, `${role.role}.agent.md`), role.role);
  }

  for (const file of expected) {
    const target = path.join(root, file.relativePath);
    if (!existsSync(target)) {
      problems.push({
        message:
          `${file.relativePath} is missing. The canonical role "${owner.get(file.relativePath) ?? ''}" ` +
          'has no provider adapter in that directory.',
        relativePath: file.relativePath,
        expected: file.content,
      });
      continue;
    }
    const onDisk = readFileSync(target, 'utf8');
    if (onDisk !== file.content) {
      problems.push({
        message: `${file.relativePath} does not match the generated adapter.`,
        relativePath: file.relativePath,
        expected: file.content,
      });
    }
  }

  for (const [directory, suffix] of [
    [CLAUDE_DIR, '.md'],
    [COPILOT_DIR, '.agent.md'],
  ] as const) {
    for (const name of listProviderFiles(root, directory, suffix)) {
      const relativePath = path.posix.join(directory, name);
      if (known.has(relativePath)) continue;
      problems.push({
        message: `${relativePath} has no canonical role under ${CANONICAL_DIR}/.`,
        relativePath,
      });
    }
  }

  return problems;
}

/**
 * Writes the adapters. Never writes into the canonical directory.
 */
export function writeAdapters(root: string, roles: readonly Role[]): number {
  let written = 0;
  for (const file of expectedFiles(roles)) {
    const target = path.join(root, file.relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
    written += 1;
  }
  return written;
}

function parseRoot(argv: readonly string[]): string {
  const index = argv.indexOf('--root');
  if (index !== -1 && argv[index + 1] !== undefined) {
    return path.resolve(argv[index + 1]);
  }
  return ROOT;
}

export function main(argv: readonly string[]): number {
  const check = argv.includes('--check');
  const root = parseRoot(argv);

  // A broken canonical role is fatal in both modes: the adapters cannot be
  // rendered from it, so writing them would only hide the problem.
  const { roles, problems: canonicalProblems } = collectRoles(root);
  if (canonicalProblems.length > 0) {
    process.stderr.write(
      `${canonicalProblems.map((problem) => `  - ${problem.message}`).join('\n')}\n`,
    );
    return 1;
  }

  if (check) {
    const problems = findProblems(root);
    if (problems.length > 0) {
      const lines: string[] = ['The agent role adapters are out of date.'];
      for (const problem of problems) {
        lines.push(`  - ${problem.message}`);
        if (problem.expected !== undefined) {
          lines.push('    expected content:');
          lines.push(
            problem.expected
              .split('\n')
              .map((line) => `      ${line}`)
              .join('\n'),
          );
        }
      }
      lines.push('Run `pnpm exec tsx scripts/generate-agent-surface.ts` and commit the result.');
      process.stderr.write(`${lines.join('\n')}\n`);
      return 1;
    }
    console.log(`The agent role adapters are up to date (${roles.length} roles).`);
    return 0;
  }

  const written = writeAdapters(root, roles);
  console.log(`The agent role adapters are written (${roles.length} roles, ${written} files).`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.join(SCRIPT_DIR, 'generate-agent-surface.ts');
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
