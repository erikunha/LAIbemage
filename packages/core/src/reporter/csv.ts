import type { ProcessedResult } from '../types.js';

const CSV_COLUMNS = [
  'number',
  'originalFile',
  'outputFile',
  'category',
  'date',
  'shortDescription',
  'confidence',
  'elements',
  'extractedText',
] as const;

/** Escape a value for embedding in a CSV field (RFC 4180). */
function csvField(value: string | number): string {
  const str = String(value);
  // Always quote fields that contain commas, quotes, or newlines
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Build a RFC-4180 CSV string from an array of ProcessedResult records. */
export function buildCsvContent(images: readonly ProcessedResult[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = images.map((img) => {
    return [
      csvField(img.number),
      csvField(img.originalFile),
      csvField(img.outputFile),
      csvField(img.category),
      csvField(formatDate(img.timestamp)),
      csvField(img.shortDescription),
      csvField(img.confidence.toFixed(2)),
      csvField(img.elements.join(' | ')),
      csvField(img.extractedText ?? ''),
    ].join(',');
  });
  return [header, ...rows].join('\r\n') + '\r\n';
}
