/**
 * Auto-generates the CLI reference table in README.md from Commander option definitions.
 *
 * Usage:
 *   pnpm run readme:generate   — rewrite the table in README.md
 *   pnpm run readme:check      — exit 1 if the table is out of date (used in CI)
 *
 * The table is written between <!-- flags-start --> and <!-- flags-end --> markers.
 * Only options from the main `program` block are included (not subcommands).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLI_SRC = path.join(ROOT, 'packages', 'cli', 'src', 'index.ts');
const README = path.join(ROOT, 'README.md');

const MARKER_START = '<!-- flags-start -->';
const MARKER_END = '<!-- flags-end -->';

interface OptionEntry {
  readonly flags: string;
  readonly description: string;
  readonly defaultValue: string | undefined;
}

/**
 * Parse .option() calls from the main program block only (before first subcommand comment).
 * Handles both single-line and multi-line .option() definitions.
 */
function extractMainCommandOptions(src: string): readonly OptionEntry[] {
  const subCmdIdx = src.indexOf('// Reorder subcommand');
  const mainBlock = subCmdIdx > 0 ? src.slice(0, subCmdIdx) : src;

  const entries: OptionEntry[] = [];

  // Matches .option('flags', 'description') and .option('flags', 'description', default)
  // \s* handles newlines and indentation in multi-line definitions.
  // ,? before \) handles Prettier's trailingComma:"all" on multi-line calls.
  const re =
    /\.option\(\s*'([^']+)'\s*,\s*'([^']*)'\s*(?:,\s*((?:'[^']*'|false|true|\d[\d.]*)))?\s*,?\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(mainBlock)) !== null) {
    const [, flags, description, rawDefault] = match;
    const defaultValue =
      rawDefault !== undefined ? rawDefault.trim().replace(/^'|'$/g, '') : undefined;
    entries.push({ flags, description, defaultValue });
  }

  return entries;
}

/**
 * Split a Commander flags string into the flag part and the argument part.
 * e.g. "-i, --input <dir>" → { flag: "-i, --input", arg: "<dir>" }
 * e.g. "--dry-run"         → { flag: "--dry-run",   arg: "" }
 */
function splitFlags(flags: string): { flag: string; arg: string } {
  const argMatch = flags.match(/^([^<[]+?)(\s+[<[].*)?$/);
  return {
    flag: argMatch?.[1]?.trim() ?? flags,
    arg: argMatch?.[2]?.trim() ?? '',
  };
}

function generateTable(options: readonly OptionEntry[]): string {
  const rows = options.map(({ flags, description, defaultValue }) => {
    const { flag, arg } = splitFlags(flags);
    const flagCell = `\`${flag}\``;
    const argCell = arg ? `\`${arg}\`` : '';
    const defaultCell = defaultValue !== undefined ? `\`${defaultValue}\`` : '—';
    return `| ${flagCell} | ${argCell} | ${description} | ${defaultCell} |`;
  });

  return [
    '| Flag | Argument | Description | Default |',
    '| ---- | -------- | ----------- | ------- |',
    ...rows,
  ].join('\n');
}

function injectTable(readme: string, table: string): string {
  const startIdx = readme.indexOf(MARKER_START);
  const endIdx = readme.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Could not find ${MARKER_START} / ${MARKER_END} markers in README.md.\n` +
        `Add them around the CLI reference table.`,
    );
  }

  const before = readme.slice(0, startIdx + MARKER_START.length);
  const after = readme.slice(endIdx);
  return `${before}\n\n${table}\n\n${after}`;
}

async function main(): Promise<void> {
  const isCheck = process.argv.includes('--check');

  const [src, readme] = await Promise.all([readFile(CLI_SRC, 'utf8'), readFile(README, 'utf8')]);

  const options = extractMainCommandOptions(src);
  const table = generateTable(options);
  const updated = injectTable(readme, table);

  if (isCheck) {
    if (updated !== readme) {
      console.error(
        'README.md CLI reference table is out of date.\n' +
          'Run `pnpm run readme:generate` and commit the result.',
      );
      process.exit(1);
    }
    console.log(`README.md CLI reference is up to date (${options.length} flags).`);
    return;
  }

  await writeFile(README, updated, 'utf8');
  console.log(`README.md updated — ${options.length} flags written.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
