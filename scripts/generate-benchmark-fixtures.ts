/**
 * Benchmark fixture generator.
 *
 * Creates 24 synthetic 200×200 JPEG images (8 categories × 3 variants) and
 * writes packages/core/tests/fixtures/benchmark/labels.json with ground-truth category labels.
 *
 * Images are solid-colour JPEGs — sufficient for infrastructure testing; a real
 * accuracy benchmark requires real photos.
 *
 * Run: npx tsx scripts/generate-benchmark-fixtures.ts
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_DIR = path.join(__dirname, '..', 'packages', 'core', 'tests', 'fixtures', 'benchmark');
const IMAGES_DIR = path.join(BENCHMARK_DIR, 'images');

// ---------------------------------------------------------------------------
// Category palette — one distinct colour per category
// ---------------------------------------------------------------------------

interface CategorySpec {
  name: string;
  /** Base RGB — variants shift brightness by ±20 */
  r: number;
  g: number;
  b: number;
}

const CATEGORIES: CategorySpec[] = [
  { name: 'kitchen', r: 220, g: 180, b: 80 },
  { name: 'bathroom', r: 80, g: 180, b: 220 },
  { name: 'bedroom', r: 180, g: 80, b: 220 },
  { name: 'living_room', r: 220, g: 80, b: 80 },
  { name: 'common_area', r: 80, g: 220, b: 80 },
  { name: 'exterior', r: 100, g: 160, b: 100 },
  { name: 'payment_receipt', r: 240, g: 240, b: 240 },
  { name: 'conversation_screenshot', r: 60, g: 60, b: 200 },
];

const VARIANTS = 3;

interface LabelEntry {
  file: string;
  category: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, v));
}

async function generateImage(category: CategorySpec, variant: number): Promise<string> {
  const shift = (variant - 1) * 20 - 20; // -20, 0, +20
  const r = clamp(category.r + shift);
  const g = clamp(category.g + shift);
  const b = clamp(category.b + shift);

  const filename = `${category.name}-${variant}.jpg`;
  const outPath = path.join(IMAGES_DIR, filename);

  if (await exists(outPath)) {
    return filename;
  }

  const pixels = Buffer.alloc(200 * 200 * 3);
  for (let i = 0; i < 200 * 200; i++) {
    pixels[i * 3] = r;
    pixels[i * 3 + 1] = g;
    pixels[i * 3 + 2] = b;
  }

  await sharp(pixels, { raw: { width: 200, height: 200, channels: 3 } })
    .jpeg({ quality: 85 })
    .toFile(outPath);

  return filename;
}

async function main(): Promise<void> {
  await mkdir(IMAGES_DIR, { recursive: true });

  const labels: LabelEntry[] = [];

  for (const category of CATEGORIES) {
    for (let v = 1; v <= VARIANTS; v++) {
      const filename = await generateImage(category, v);
      labels.push({ file: filename, category: category.name });
    }
  }

  const labelsPath = path.join(BENCHMARK_DIR, 'labels.json');
  await writeFile(
    labelsPath,
    JSON.stringify(
      {
        description:
          'Ground-truth category labels for the accuracy benchmark. ' +
          'Images are synthetic colour swatches — replace with real photos for meaningful accuracy metrics.',
        categories: CATEGORIES.map((c) => c.name),
        images: labels,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`[benchmark-fixtures] ${CATEGORIES.length * VARIANTS} images → ${IMAGES_DIR}`);
  console.log(`[benchmark-fixtures] labels.json → ${labelsPath}`);
}

main().catch((err: unknown) => {
  console.error('[benchmark-fixtures] Error:', err);
  process.exit(1);
});
