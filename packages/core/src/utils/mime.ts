import { fileTypeFromFile } from 'file-type';

/**
 * Magic-byte MIME types accepted as valid input images.
 * Extension filtering is done separately by IMAGE_REGEX; this guard catches
 * files that have been given a supported extension but contain different data
 * (e.g. a PNG renamed to .jpg, or a non-image with a .jpg extension).
 */
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/avif',
]);

export interface MimeValidationResult {
  readonly valid: boolean;
  /** The MIME type detected from magic bytes, or undefined if undetectable. */
  readonly detectedMime: string | undefined;
}

/**
 * Detects the MIME type from magic bytes and checks whether it is an accepted
 * image type.  Returns both the validity flag and the raw detected MIME so that
 * callers can include it in warning messages without a second file read.
 */
export async function validateImageMimeType(filePath: string): Promise<MimeValidationResult> {
  const type = await fileTypeFromFile(filePath);
  return {
    valid: !!(type && ALLOWED_MIME_TYPES.has(type.mime)),
    detectedMime: type?.mime,
  };
}
