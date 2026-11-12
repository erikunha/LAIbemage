import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_MIME_TYPES, validateImageMimeType } from '../../src/utils/mime.js';
import { FIXTURES, fixturePath } from '../fixtures/index.js';

// ---------------------------------------------------------------------------
// ALLOWED_MIME_TYPES constant
// ---------------------------------------------------------------------------

describe('ALLOWED_MIME_TYPES', () => {
  it('contains exactly the five expected types', () => {
    expect([...ALLOWED_MIME_TYPES].sort()).toEqual([
      'image/avif',
      'image/jpeg',
      'image/png',
      'image/tiff',
      'image/webp',
    ]);
  });
});

// ---------------------------------------------------------------------------
// validateImageMimeType — real fixture JPEG files
// ---------------------------------------------------------------------------

describe('validateImageMimeType', () => {
  it('accepts fixture JPEG files as valid', async () => {
    for (const fixture of FIXTURES) {
      const result = await validateImageMimeType(fixture.path);
      expect(result.valid, `${fixture.name} should be valid`).toBe(true);
      expect(result.detectedMime).toBe('image/jpeg');
    }
  });

  it('rejects a plain text file disguised as .jpg', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mime-test-'));
    const fakePath = path.join(tmpDir, 'not-an-image.jpg');
    await writeFile(fakePath, 'this is plain text, not an image');
    try {
      const result = await validateImageMimeType(fakePath);
      expect(result.valid).toBe(false);
      // file-type cannot detect a MIME for plain text
      expect(result.detectedMime).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns detectedMime for a non-image file with a recognised magic signature', async () => {
    // PDF magic bytes — detectable but not an allowed image type
    const pdfMagic = Buffer.from('%PDF-1.4\n%');
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mime-test-'));
    const fakePath = path.join(tmpDir, 'document.jpg');
    await writeFile(fakePath, pdfMagic);
    try {
      const result = await validateImageMimeType(fakePath);
      expect(result.valid).toBe(false);
      expect(result.detectedMime).toBe('application/pdf');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses the first fixture path via fixturePath helper', async () => {
    const p = fixturePath(FIXTURES[0].name);
    const result = await validateImageMimeType(p);
    expect(result.valid).toBe(true);
  });
});
