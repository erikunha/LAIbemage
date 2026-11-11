/**
 * Generates the provider adapters of the path-scoped rules from the canonical
 * sources under `.agents/rules/`.
 *
 * Usage:
 *   pnpm run agents:rules        -- rewrite the adapters
 *   pnpm run agents:rules:check  -- exit 1 if an adapter is out of date
 *
 * The two runtimes read different frontmatter keys: Claude Code reads the
 * `paths:` list, GitHub Copilot reads one `applyTo:` glob string. A single
 * file carrying both keys might be rejected by one of them, and that cannot
 * be tested from here, so the repository keeps one canonical body and
 * generates one adapter per runtime from it.
 *
 * The check also fails when a rule's `paths:` matches nothing on disk. A glob
 * that matches no file is a silent hole: the rule looks present and never
 * fires.
 */
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_DIR = path.join('.agents', 'rules');
const CLAUDE_DIR = path.join('.claude', 'rules');
const COPILOT_DIR = path.join('.github', 'instructions');

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'coverage',
  'dist',
  'node_modules',
  'output',
  'reports',
]);

interface Rule {
  readonly name: string;
  readonly paths: readonly string[];
  readonly body: string;
}

/**
 * Parses one canonical rule: the frontmatter `name` and `paths:` list, and
 * the body that follows it.
 */
export function parseRule(source: string, file: string): Rule {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (match === null) {
    throw new Error(`${file} has no YAML frontmatter`);
  }
  const [, frontmatter, body] = match;

  const nameMatch = /^name:\s*(\S+)\s*$/m.exec(frontmatter);
  if (nameMatch === null) {
    throw new Error(`${file} has no 'name' in its frontmatter`);
  }
  const name = nameMatch[1];

  const pathsSection = /paths:\s*\r?\n((?:\s+-\s+.+\r?\n?)+)/.exec(frontmatter);
  if (pathsSection === null) {
    throw new Error(`${file} has no 'paths' list in its frontmatter`);
  }
  const paths = pathsSection[1]
    .split('\n')
    .map((line) => line.replace(/^\s+-\s+/, '').trim())
    .filter((line) => line.length > 0);

  if (paths.length === 0) {
    throw new Error(`${file} declares an empty 'paths' list`);
  }

  return { name, paths, body: body.replace(/^\r?\n/, '') };
}

/**
 * The Claude Code adapter: the same `paths:` list the canonical rule carries.
 */
export function renderClaude(rule: Rule): string {
  const frontmatter = ['---', 'paths:', ...rule.paths.map((p) => `  - ${p}`), '---', ''].join('\n');
  return `${frontmatter}\n${rule.body}`;
}

/**
 * The GitHub Copilot adapter: one `applyTo:` string, the globs joined by a
 * comma.
 */
export function renderCopilot(rule: Rule): string {
  const frontmatter = ['---', `applyTo: '${rule.paths.join(',')}'`, '---', ''].join('\n');
  return `${frontmatter}\n${rule.body}`;
}

/**
 * Turns one glob into a regular expression: `**` crosses directories, `*`
 * stays inside a segment.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          pattern += '(?:[^/]+/)*';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    pattern += char.replace(/[.+?^${}()|[\]\\]/, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Every file in the tree, as paths relative to the root.
 *
 * A symlink to a directory is walked as a directory, because the provider
 * adapters under `.claude/skills` and `.github/skills` are symlinks and a rule
 * that points at them has to find them. The real path of every ANCESTOR is
 * remembered, so a symlink that points at its own ancestor ends the walk
 * instead of looping, while a symlink that points at a sibling of an ancestor
 * is still walked.
 */
export async function listFiles(
  root: string,
  relative = '',
  ancestors: readonly string[] = [],
): Promise<string[]> {
  const absolute = path.join(root, relative);
  const real = await realpath(absolute).catch(() => absolute);
  if (ancestors.includes(real)) return [];
  const chain = [...ancestors, real];

  const entries = await readdir(absolute, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const next = relative === '' ? entry.name : path.join(relative, entry.name);
    const info = await stat(path.join(root, next)).catch(() => undefined);
    if (info === undefined) continue;
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await listFiles(root, next, chain)));
      continue;
    }
    if (info.isFile()) {
      found.push(next.split(path.sep).join('/'));
    }
  }
  return found;
}

/**
 * The rules the repository has, read from the canonical directory.
 */
export async function collectRules(root: string): Promise<Rule[]> {
  const directory = path.join(root, CANONICAL_DIR);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    throw new Error(`no canonical rules under ${CANONICAL_DIR}`);
  }
  const rules: Rule[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.md')).sort()) {
    const source = await readFile(path.join(directory, entry), 'utf8');
    rules.push(parseRule(source, path.join(CANONICAL_DIR, entry)));
  }
  return rules;
}

export interface GeneratedFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * The adapters the canonical rules produce.
 */
export function expectedFiles(rules: readonly Rule[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const rule of rules) {
    files.push({
      relativePath: path.posix.join(CLAUDE_DIR, `${rule.name}.md`),
      content: renderClaude(rule),
    });
    files.push({
      relativePath: path.posix.join(COPILOT_DIR, `${rule.name}.instructions.md`),
      content: renderCopilot(rule),
    });
  }
  return files;
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The reason the check fails, or `undefined` when everything agrees.
 */
export async function findProblems(root: string): Promise<string[]> {
  const problems: string[] = [];
  const rules = await collectRules(root);

  const files = await listFiles(root);
  const fileSet = new Set(files);

  for (const rule of rules) {
    for (const glob of rule.paths) {
      const matcher = globToRegExp(glob);
      if (!files.some((file) => matcher.test(file))) {
        problems.push(
          `the rule '${rule.name}' has a path that matches no file: ${glob}. ` +
            'A glob that matches nothing is a silent hole.',
        );
      }
    }
  }

  for (const expected of expectedFiles(rules)) {
    const onDisk = await readIfPresent(path.join(root, expected.relativePath));
    if (onDisk === undefined) {
      problems.push(`${expected.relativePath} is missing. Run the generator.`);
      continue;
    }
    if (onDisk !== expected.content) {
      problems.push(
        `${expected.relativePath} does not match its canonical rule. ` +
          'Run the generator and commit the result.',
      );
    }
  }

  const known = new Set(expectedFiles(rules).map((file) => file.relativePath));
  for (const directory of [CLAUDE_DIR, COPILOT_DIR]) {
    let entries: string[];
    try {
      entries = await readdir(path.join(root, directory));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = path.posix.join(directory, entry);
      if (!known.has(relative)) {
        problems.push(`${relative} has no canonical rule under ${CANONICAL_DIR}.`);
      }
    }
  }

  return problems;
}

export async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  const rootIndex = argv.indexOf('--root');
  const root =
    rootIndex >= 0 && argv[rootIndex + 1] !== undefined
      ? path.resolve(argv[rootIndex + 1])
      : ROOT;

  const problems = await findProblems(root);

  if (check) {
    if (problems.length > 0) {
      process.stderr.write(
        `The path-scoped rules are out of date.\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
          'Run `pnpm run agents:rules` and commit the result.\n',
      );
      return 1;
    }
    const rules = await collectRules(root);
    console.log(`The path-scoped rules are up to date (${rules.length} rules).`);
    return 0;
  }

  const rules = await collectRules(root);
  for (const file of expectedFiles(rules)) {
    const target = path.join(root, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  console.log(`The path-scoped rule adapters are written (${rules.length} rules).`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
