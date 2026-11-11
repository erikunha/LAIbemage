#!/usr/bin/env node
/**
 * Render every Mermaid block in a markdown file to a PNG, so a reviewer can
 * look at the picture instead of trusting the source.
 *
 * Usage:
 *   node scripts/render-mermaid.mjs <file.md> [more.md ...] [--out <dir>]
 *
 * The renderer is mermaid-cli driven by the local Chrome, through
 * PUPPETEER_EXECUTABLE_PATH, so no Chromium download is needed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex === -1 ? path.join(os.tmpdir(), 'mermaid-render') : args[outIndex + 1];
const files = args.filter((a, i) => a !== '--out' && !(outIndex !== -1 && i === outIndex + 1));

if (files.length === 0) {
  console.error('usage: node scripts/render-mermaid.mjs <file.md> [...] [--out <dir>]');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const puppeteerConfig = path.join(outDir, 'puppeteer.json');
writeFileSync(
  puppeteerConfig,
  JSON.stringify({ executablePath: existsSync(CHROME) ? CHROME : undefined, args: ['--no-sandbox'] }),
  'utf8',
);

let rendered = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const blocks = [...source.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]);
  const stem = path.basename(file).replace(/\.md$/, '');
  blocks.forEach((block, index) => {
    const mmd = path.join(outDir, `${stem}-${index + 1}.mmd`);
    const png = path.join(outDir, `${stem}-${index + 1}.png`);
    writeFileSync(mmd, block, 'utf8');
    execFileSync(
      'npx',
      ['-y', '@mermaid-js/mermaid-cli@11', '-i', mmd, '-o', png, '-p', puppeteerConfig, '-b', 'transparent'],
      { stdio: 'inherit' },
    );
    rendered += 1;
    console.log(`rendered ${file} block ${index + 1} -> ${png}`);
  });
  if (blocks.length === 0) console.log(`no mermaid block in ${file}`);
}

console.log(`done: ${rendered} diagram(s) rendered into ${outDir}`);
