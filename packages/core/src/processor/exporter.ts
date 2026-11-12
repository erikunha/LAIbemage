import path from 'node:path';
import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import {
  buildTimestampSvg,
  calculateFontSize,
  calculateOverlayPosition,
  formatTimestamp,
} from './overlay.js';

export interface ExportOptions {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly timestampMs: number;
  readonly skipOverlay: boolean;
  readonly timezone: string;
  readonly dryRun?: boolean;
}

export async function exportImage(options: ExportOptions): Promise<void> {
  const { inputPath, outputPath, timestampMs, skipOverlay, timezone, dryRun } = options;

  if (dryRun) {
    logger.verbose(`  [dry-run] Would write: ${path.basename(outputPath)}`);
    return;
  }

  const image = sharp(inputPath);
  const { width = 1000, height = 1000 } = await image.metadata();

  if (skipOverlay) {
    await image
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4', mozjpeg: false })
      .withMetadata()
      .toFile(outputPath);
    return;
  }

  const fontSize = calculateFontSize(height);
  const dateText = formatTimestamp(timestampMs, timezone);
  const { svg, overlayWidth, overlayHeight } = buildTimestampSvg(dateText, fontSize);
  const { left, top } = calculateOverlayPosition(width, height, overlayWidth, overlayHeight);

  await image
    .composite([{ input: svg, top, left }])
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4', mozjpeg: false })
    .withMetadata()
    .toFile(outputPath);
}

/** Default output filename template — mirrors the original hard-coded format. */
const DEFAULT_TEMPLATE = '{n}. Photo of {category} dated {date}';

/** Strip characters that can cause path traversal or filesystem issues in filename segments. */
function sanitizeSegment(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[/\\<>:|?*\x00]/g, '');
}

/**
 * Apply a user-supplied date format string to a local-time Date.
 * Supported tokens (processed longest-first so shorter tokens cannot shadow longer ones):
 *   YYYY  4-digit year (2024)
 *   YY    2-digit year (24)
 *   MM    zero-padded month (01–12)
 *   DD    zero-padded day (01–31)
 *   HH    zero-padded 24 h hour (00–23)
 *   mm    zero-padded minute (00–59)
 *   ss    zero-padded second (00–59)
 *   M     month without padding (1–12)
 *   D     day without padding (1–31)
 *   H     hour without padding (0–23)
 *   m     minute without padding (0–59)
 *   s     second without padding (0–59)
 *
 * Example: applyDateFormat(date, 'YYYY-MM-DD') → '2024-06-15'
 */
export function applyDateFormat(localDate: Date, format: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const tokens: [string, string][] = [
    ['YYYY', String(localDate.getFullYear())],
    ['YY', String(localDate.getFullYear()).slice(-2)],
    ['MM', p2(localDate.getMonth() + 1)],
    ['DD', p2(localDate.getDate())],
    ['HH', p2(localDate.getHours())],
    ['mm', p2(localDate.getMinutes())],
    ['ss', p2(localDate.getSeconds())],
    ['M', String(localDate.getMonth() + 1)],
    ['D', String(localDate.getDate())],
    ['H', String(localDate.getHours())],
    ['m', String(localDate.getMinutes())],
    ['s', String(localDate.getSeconds())],
  ];
  let result = format;
  for (const [token, value] of tokens) {
    result = result.split(token).join(value);
  }
  return result;
}

export function buildOutputName(
  number: number,
  category: string,
  timestampMs: number,
  timezone: string,
  keepOriginalBasename?: string,
  template?: string,
  description?: string,
): string {
  if (keepOriginalBasename) {
    return `${path.basename(keepOriginalBasename, path.extname(keepOriginalBasename))}.jpeg`;
  }

  const tpl = template ?? DEFAULT_TEMPLATE;
  const date = new Date(timestampMs);
  const local = new Date(date.toLocaleString('en-US', { timeZone: timezone }));

  // Precomputed legacy values for bare {date} / {datetime} (backward-compat)
  const d = String(local.getDate()).padStart(2, '0');
  const mo = String(local.getMonth() + 1).padStart(2, '0');
  const y = local.getFullYear();
  const hh = String(local.getHours()).padStart(2, '0');
  const min = String(local.getMinutes()).padStart(2, '0');

  const safeCategory = sanitizeSegment((category || 'unknown').toLowerCase().replace(/_/g, ' '));
  const descSlug = (description ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  const safeDescription = sanitizeSegment(descSlug || 'no-description');

  return (
    tpl.replace(
      /{(\w+)(?::([^}]*))?}/g,
      (_match: string, token: string, fmt: string | undefined) => {
        switch (token) {
          case 'n':
            return String(number).padStart(fmt ? Math.max(1, parseInt(fmt, 10)) : 3, '0');
          case 'category':
            return safeCategory;
          case 'date':
            return fmt ? applyDateFormat(local, fmt) : `${d}-${mo}-${y}`;
          case 'datetime':
            return fmt ? applyDateFormat(local, fmt) : `${d}-${mo}-${y}_${hh}-${min}`;
          case 'description':
            return safeDescription;
          default:
            return _match;
        }
      },
    ) + '.jpeg'
  );
}
