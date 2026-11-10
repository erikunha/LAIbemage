/**
 * Fixture image generator — creates minimal 100×100 JPEG files for testing.
 * Each fixture has a distinct solid colour and an embedded EXIF DateTimeOriginal.
 *
 * Run: npx tsx scripts/generate-fixtures.ts
 * Output: tests/fixtures/images/ (git-ignored)
 */
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'packages', 'core', 'tests', 'fixtures', 'images');

interface FixtureSpec {
  name: string;
  r: number;
  g: number;
  b: number;
  /** Unix timestamp in seconds for EXIF DateTimeOriginal */
  ts: number;
}

const FIXTURES: FixtureSpec[] = [
  { name: 'red.jpg', r: 220, g: 50, b: 50, ts: 1_700_000_000 },
  { name: 'green.jpg', r: 50, g: 200, b: 80, ts: 1_700_001_000 },
  { name: 'blue.jpg', r: 50, g: 80, b: 220, ts: 1_700_002_000 },
  { name: 'white.jpg', r: 250, g: 250, b: 250, ts: 1_700_003_000 },
  { name: 'dark.jpg', r: 30, g: 30, b: 30, ts: 1_700_004_000 },
  { name: 'yellow.jpg', r: 240, g: 220, b: 50, ts: 1_700_005_000 },
];

function formatExifDate(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function alreadyExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function generate(spec: FixtureSpec): Promise<void> {
  const outPath = path.join(OUTPUT_DIR, spec.name);
  if (await alreadyExists(outPath)) {
    return;
  }

  const pixels = Buffer.alloc(100 * 100 * 3);
  for (let i = 0; i < 100 * 100; i++) {
    pixels[i * 3] = spec.r;
    pixels[i * 3 + 1] = spec.g;
    pixels[i * 3 + 2] = spec.b;
  }

  await sharp(pixels, { raw: { width: 100, height: 100, channels: 3 } })
    .withMetadata({
      exif: {
        IFD0: {
          // Store DateTimeOriginal in EXIF IFD Exif tag
          Copyright: formatExifDate(spec.ts),
        },
      },
    })
    .jpeg({ quality: 80 })
    .toFile(outPath);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  await Promise.all(FIXTURES.map(generate));

  console.log(`[fixtures] ${FIXTURES.length} fixture images ready in ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('[fixtures] Error:', err);
  process.exit(1);
});
