import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOutputName } from '../../src/processor/exporter.js';
import { reorderImages } from '../../src/processor/reorder.js';
import type { ProcessedResult } from '../../src/types.js';

const T1 = new Date('2024-06-15T12:00:00.000Z').getTime();

function makeImage(overrides: Partial<ProcessedResult>): ProcessedResult {
  return {
    originalFile: 'original.jpg',
    outputFile: 'output.jpeg',
    category: 'kitchen',
    number: 1,
    shortDescription: 'a room',
    elements: [],
    confidence: 0,
    extractedText: null,
    timestamp: T1,
    ...overrides,
  };
}

describe('reorderImages', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('resolves immediately when the images array is empty', async () => {
    const result = await reorderImages(tmpDir, [], 'UTC');
    expect(result).toEqual([]);
  });

  it('renames a single file and returns updated outputFile + number', async () => {
    const img = makeImage({ outputFile: 'old_kitchen.jpeg', category: 'kitchen' });
    await fs.writeFile(path.join(tmpDir, 'old_kitchen.jpeg'), 'content-a');

    const result = await reorderImages(tmpDir, [img], 'UTC');

    const expectedName = buildOutputName(1, 'kitchen', T1, 'UTC');
    expect(result[0]?.outputFile).toBe(expectedName);
    expect(result[0]?.number).toBe(1);
    expect(await fs.pathExists(path.join(tmpDir, expectedName))).toBe(true);
    // old name must be gone
    expect(await fs.pathExists(path.join(tmpDir, 'old_kitchen.jpeg'))).toBe(false);
    // content must be preserved
    expect(await fs.readFile(path.join(tmpDir, expectedName), 'utf-8')).toBe('content-a');
    // original img object is NOT mutated
    expect(img.outputFile).toBe('old_kitchen.jpeg');
  });

  it('two-phase rename prevents collision when A new-name equals B old-name', async () => {
    // Image A will be renamed to a name that image B currently holds.
    // Without the two-phase strategy, phase 2 would clobber B's content.
    const nameB = buildOutputName(1, 'kitchen', T1, 'UTC'); // '001. Photo of kitchen dated 15-06-2024.jpeg'

    const imgA = makeImage({ outputFile: 'old_kitchen.jpeg', category: 'kitchen', number: 1 });
    const imgB = makeImage({ outputFile: nameB, category: 'bathroom', number: 2 });

    await fs.writeFile(path.join(tmpDir, 'old_kitchen.jpeg'), 'content-a');
    await fs.writeFile(path.join(tmpDir, nameB), 'content-b');

    const result = await reorderImages(tmpDir, [imgA, imgB], 'UTC');

    const finalNameA = buildOutputName(1, 'kitchen', T1, 'UTC');
    const finalNameB = buildOutputName(2, 'bathroom', T1, 'UTC');

    // Both returned items have updated names
    expect(result[0]?.outputFile).toBe(finalNameA);
    expect(result[0]?.number).toBe(1);
    expect(result[1]?.outputFile).toBe(finalNameB);
    expect(result[1]?.number).toBe(2);

    // Content must not be mixed up
    expect(await fs.readFile(path.join(tmpDir, finalNameA), 'utf-8')).toBe('content-a');
    expect(await fs.readFile(path.join(tmpDir, finalNameB), 'utf-8')).toBe('content-b');
  });

  it('skips missing files without throwing and leaves other files intact', async () => {
    const imgPresent = makeImage({ outputFile: 'present.jpeg', category: 'kitchen', number: 1 });
    const imgMissing = makeImage({
      outputFile: 'missing.jpeg',
      category: 'bathroom',
      number: 2,
      originalFile: 'missing_orig.jpg',
    });

    await fs.writeFile(path.join(tmpDir, 'present.jpeg'), 'content-present');
    // 'missing.jpeg' deliberately not written to disk

    const result = await reorderImages(tmpDir, [imgPresent, imgMissing], 'UTC');

    // Present file was renamed
    const finalName = buildOutputName(1, 'kitchen', T1, 'UTC');
    expect(await fs.pathExists(path.join(tmpDir, finalName))).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, finalName), 'utf-8')).toBe('content-present');

    // Missing image: outputFile unchanged in returned result (no tmp was created so rename was skipped)
    expect(result[1]?.outputFile).toBe('missing.jpeg');
  });

  it('preserves file content when the output file is already the final name', async () => {
    // idempotent case: the image already has the correct sequential name
    const finalName = buildOutputName(1, 'kitchen', T1, 'UTC');
    const img = makeImage({ outputFile: finalName, category: 'kitchen', number: 1 });
    await fs.writeFile(path.join(tmpDir, finalName), 'content-idempotent');

    const result = await reorderImages(tmpDir, [img], 'UTC');

    expect(result[0]?.outputFile).toBe(finalName);
    expect(result[0]?.number).toBe(1);
    expect(await fs.readFile(path.join(tmpDir, finalName), 'utf-8')).toBe('content-idempotent');
  });
});
