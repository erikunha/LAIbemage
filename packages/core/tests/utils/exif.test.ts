import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getImageTimestamp } from '../../src/utils/exif.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'images');

// Mock exifr at module level so we can control its response per test
vi.mock('exifr', () => ({
  default: {
    parse: vi.fn(),
  },
}));

describe('getImageTimestamp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exif source when DateTimeOriginal is available', async () => {
    const { default: exifr } = await import('exifr');
    const mockDate = new Date('2023-11-01T10:00:00.000Z');
    vi.mocked(exifr.parse).mockResolvedValue({ DateTimeOriginal: mockDate });

    const fixturePath = path.join(FIXTURES_DIR, 'red.jpg');
    const result = await getImageTimestamp(fixturePath);

    expect(result.exifSource).toBe('exif');
    expect(result.createdAt).toBe(mockDate.getTime());
  });

  it('falls back to birthtime when EXIF returns null', async () => {
    const { default: exifr } = await import('exifr');
    vi.mocked(exifr.parse).mockResolvedValue(null);

    const fixturePath = path.join(FIXTURES_DIR, 'green.jpg');
    const result = await getImageTimestamp(fixturePath);

    // Fixture files have birthtimeMs set on macOS; either 'birthtime' or 'ctime'
    expect(['birthtime', 'ctime']).toContain(result.exifSource);
    expect(typeof result.createdAt).toBe('number');
    expect(result.createdAt).toBeGreaterThan(0);
  });

  it('falls back to ctime when exifr throws', async () => {
    const { default: exifr } = await import('exifr');
    vi.mocked(exifr.parse).mockRejectedValue(new Error('not a JPEG'));

    const fixturePath = path.join(FIXTURES_DIR, 'blue.jpg');
    const result = await getImageTimestamp(fixturePath);

    // On parse error, exif is skipped; should fall back to filesystem
    expect(['birthtime', 'ctime']).toContain(result.exifSource);
    expect(result.createdAt).toBeGreaterThan(0);
  });

  it('falls back to ctime when DateTimeOriginal is not a valid Date', async () => {
    const { default: exifr } = await import('exifr');
    vi.mocked(exifr.parse).mockResolvedValue({ DateTimeOriginal: 'not-a-date' });

    const fixturePath = path.join(FIXTURES_DIR, 'white.jpg');
    const result = await getImageTimestamp(fixturePath);

    expect(['birthtime', 'ctime']).toContain(result.exifSource);
    expect(result.createdAt).toBeGreaterThan(0);
  });
});
