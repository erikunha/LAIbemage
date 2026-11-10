import { stat } from 'node:fs/promises';
import type { ExifSource } from '../types.js';

interface ExifData {
  DateTimeOriginal?: Date;
}

/**
 * Attempt to read the EXIF DateTimeOriginal from a JPEG/TIFF file.
 * Falls back to filesystem birthtime, then ctime, in that order.
 *
 * Returns the timestamp in milliseconds since epoch and the source that was used.
 */
export async function getImageTimestamp(
  fullPath: string,
): Promise<{ createdAt: number; exifSource: ExifSource }> {
  // Attempt EXIF first — dynamically import exifr so this file stays tree-shakeable
  try {
    const exifr = await import('exifr');
    const data = (await exifr.default.parse(fullPath, ['DateTimeOriginal'])) as ExifData | null;
    if (data?.DateTimeOriginal instanceof Date && !isNaN(data.DateTimeOriginal.getTime())) {
      return { createdAt: data.DateTimeOriginal.getTime(), exifSource: 'exif' };
    }
  } catch {
    // exifr parse failure is non-fatal — fall through to filesystem fallback
  }

  // Filesystem fallback
  const fileStat = await stat(fullPath);
  if (fileStat.birthtimeMs && fileStat.birthtimeMs > 0) {
    return { createdAt: fileStat.birthtimeMs, exifSource: 'birthtime' };
  }
  return { createdAt: fileStat.ctimeMs, exifSource: 'ctime' };
}
