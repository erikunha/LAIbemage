/**
 * SYNTHETIC fixture dataset for the benchmark flow — spec 003, plan
 * "Integration: fixture-scale end-to-end (fake 'dataset' of 30 tiny generated
 * images) so CI exercises the whole flow without VisA".
 *
 * ⚠️ THE IMAGES WRITTEN HERE ARE SYNTHETIC. They are solid-colour blocks
 * with a painted defect patch. They are NOT photographs, they carry NO
 * information about real inspection imagery, and NO accuracy claim may ever
 * be derived from them. They exist so CI can exercise split → score → gate
 * end to end without the real dataset (whose download needs the
 * maintainer's authorisation).
 *
 * Shape (VisA-shaped):
 *   benchmarks/fixtures/synthetic-fixture/<part>/
 *     Data/Images/Normal/NNNN.JPG
 *     Data/Images/Anomaly/NNNN.JPG
 *     Data/Annotations/Anomaly/NNNN.JPG   (tiny mask, VisA-shaped)
 *     image_anno.csv                      (image,mask,label,defect_type,session)
 *
 * 3 parts × (6 normal + 4 anomalous) = 30 images. The `session` column is a
 * fixture-only extension of VisA's CSV: it marks the capture session, the
 * leakage-aware unit — items sharing a session are never split across
 * train/val/test.
 *
 * Determinism: fixed pixels, fixed EXIF timestamps, skip-if-exists guard.
 * Re-running the generator never rewrites an existing image.
 *
 * Run: pnpm exec tsx scripts/benchmarks/make-fixture-dataset.ts
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'benchmarks', 'fixtures', 'synthetic-fixture');

/** Side of the generated (tiny) images, in pixels. */
const IMAGE_SIZE = 32;

/** Unix timestamp (seconds) of the first fixture image — fixed forever. */
const BASE_TIMESTAMP = 1_700_000_000;

interface PartSpec {
  /** Directory (and class) name. */
  name: string;
  /** Base colour of the part. */
  colour: [number, number, number];
  /** Capture sessions of the normal images (counts per session). */
  normalSessions: number[];
  /** Capture sessions of the anomalous images (counts per session). */
  anomalySessions: number[];
  /** Defect type painted on the anomalous images, in order. */
  defectTypes: string[];
}

const PARTS: PartSpec[] = [
  {
    name: 'pcb1',
    colour: [40, 70, 40],
    normalSessions: [2, 2, 1, 1],
    anomalySessions: [2, 1, 1],
    defectTypes: ['scratch', 'bubble', 'chip', 'stain'],
  },
  {
    name: 'pcb2',
    colour: [40, 40, 90],
    normalSessions: [2, 2, 1, 1],
    anomalySessions: [2, 1, 1],
    defectTypes: ['scratch', 'bubble', 'chip', 'stain'],
  },
  {
    name: 'capsules',
    colour: [110, 80, 30],
    normalSessions: [2, 2, 1, 1],
    anomalySessions: [2, 1, 1],
    defectTypes: ['scratch', 'bubble', 'chip', 'stain'],
  },
];

function formatExifDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}:${pad(date.getUTCMonth() + 1)}:${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

async function alreadyExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Deterministic pixels: solid colour, plus a dark defect patch when asked. */
function renderPixels(colour: [number, number, number], defectIndex: number | null): Buffer {
  const pixels = Buffer.alloc(IMAGE_SIZE * IMAGE_SIZE * 3);
  for (let index = 0; index < IMAGE_SIZE * IMAGE_SIZE; index += 1) {
    pixels[index * 3] = colour[0];
    pixels[index * 3 + 1] = colour[1];
    pixels[index * 3 + 2] = colour[2];
  }
  if (defectIndex !== null) {
    const originX = 4 + ((defectIndex * 7) % (IMAGE_SIZE - 12));
    const originY = 4 + ((defectIndex * 11) % (IMAGE_SIZE - 12));
    for (let y = originY; y < originY + 8; y += 1) {
      for (let x = originX; x < originX + 8; x += 1) {
        const offset = (y * IMAGE_SIZE + x) * 3;
        pixels[offset] = Math.max(0, colour[0] - 90);
        pixels[offset + 1] = Math.max(0, colour[1] - 90);
        pixels[offset + 2] = Math.max(0, colour[2] - 90);
      }
    }
  }
  return pixels;
}

async function writeImage(
  target: string,
  colour: [number, number, number],
  defectIndex: number | null,
  timestamp: number,
): Promise<void> {
  if (await alreadyExists(target)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await sharp(renderPixels(colour, defectIndex), {
    raw: { width: IMAGE_SIZE, height: IMAGE_SIZE, channels: 3 },
  })
    .withMetadata({
      exif: {
        IFD0: {
          // Fixed DateTimeOriginal-ish stamp — the fixtures must be
          // byte-stable, so no wall-clock value may leak in.
          Copyright: formatExifDate(timestamp),
        },
      },
    })
    .jpeg({ quality: 80 })
    .toFile(target);
}

/** Expand session sizes into the session label of every image index. */
function sessionLabels(sizes: number[], prefix: string): string[] {
  const labels: string[] = [];
  sizes.forEach((size, index) => {
    for (let item = 0; item < size; item += 1) {
      labels.push(`${prefix}${String(index + 1).padStart(2, '0')}`);
    }
  });
  return labels;
}

async function generatePart(part: PartSpec, timestampOffset: number): Promise<number> {
  const partDir = path.join(OUTPUT_DIR, part.name);
  const normalSessions = sessionLabels(part.normalSessions, 's');
  const anomalySessions = sessionLabels(part.anomalySessions, 's');
  const rows: string[] = ['image,mask,label,defect_type,session'];
  let counter = timestampOffset;

  for (let index = 0; index < normalSessions.length; index += 1) {
    const name = `${String(index).padStart(4, '0')}.JPG`;
    const relative = `Data/Images/Normal/${name}`;
    await writeImage(path.join(partDir, relative), part.colour, null, counter);
    counter += 1;
    rows.push(`${relative},,normal,,${normalSessions[index]}`);
  }

  for (let index = 0; index < anomalySessions.length; index += 1) {
    const name = `${String(index).padStart(4, '0')}.JPG`;
    const relative = `Data/Images/Anomaly/${name}`;
    const mask = `Data/Annotations/Anomaly/${name}`;
    await writeImage(path.join(partDir, relative), part.colour, index, counter);
    counter += 1;
    await writeImage(path.join(partDir, mask), [0, 0, 0], null, counter);
    counter += 1;
    rows.push(`${relative},${mask},anomaly,${part.defectTypes[index]},${anomalySessions[index]}`);
  }

  await mkdir(partDir, { recursive: true });
  await writeFile(path.join(partDir, 'image_anno.csv'), `${rows.join('\n')}\n`, 'utf8');

  return counter - timestampOffset;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  let timestamp = BASE_TIMESTAMP;
  let images = 0;
  for (const part of PARTS) {
    const written = await generatePart(part, timestamp);
    timestamp += written;
    images += part.normalSessions.reduce((sum, size) => sum + size, 0);
    images += part.anomalySessions.reduce((sum, size) => sum + size, 0);
  }

  console.log(
    `[fixture-dataset] ${images} SYNTHETIC images ready in ${OUTPUT_DIR} ` +
      '(solid colours — never an accuracy source)',
  );
}

main().catch((error: unknown) => {
  console.error('[fixture-dataset] Error:', error);
  process.exitCode = 1;
});
