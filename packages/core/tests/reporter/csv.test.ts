import { describe, expect, it } from 'vitest';
import { buildCsvContent } from '../../src/reporter/csv.js';
import type { ProcessedResult } from '../../src/types.js';

function makeResult(overrides: Partial<ProcessedResult> = {}): ProcessedResult {
  return {
    originalFile: 'IMG_001.jpeg',
    outputFile: '001. Photo of kitchen dated 15-01-2024.jpeg',
    category: 'kitchen',
    number: 1,
    shortDescription: 'water damage above sink',
    elements: ['sink', 'water damage'],
    confidence: 0,
    extractedText: null,
    timestamp: 1705312800000, // 2024-01-15
    ...overrides,
  };
}

describe('buildCsvContent', () => {
  it('produces a header row as the first line', () => {
    const csv = buildCsvContent([]);
    const firstLine = csv.split('\r\n')[0];
    expect(firstLine).toBe(
      'number,originalFile,outputFile,category,date,shortDescription,confidence,elements,extractedText',
    );
  });

  it('ends with a trailing CRLF', () => {
    const csv = buildCsvContent([makeResult()]);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('uses CRLF line endings throughout (RFC 4180)', () => {
    const csv = buildCsvContent([makeResult(), makeResult({ number: 2 })]);
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  it('writes image number as first column', () => {
    const csv = buildCsvContent([makeResult({ number: 42 })]);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine?.startsWith('42,')).toBe(true);
  });

  it('formats timestamp as YYYY-MM-DD date', () => {
    const csv = buildCsvContent([makeResult({ timestamp: 1705312800000 })]);
    expect(csv).toContain('2024-01-15');
  });

  it('joins elements array with " | " separator', () => {
    const csv = buildCsvContent([makeResult({ elements: ['sink', 'water damage', 'tiles'] })]);
    expect(csv).toContain('sink | water damage | tiles');
  });

  it('handles empty elements array', () => {
    const csv = buildCsvContent([makeResult({ elements: [] })]);
    const dataLine = csv.split('\r\n')[1] ?? '';
    const cols = dataLine.split(',');
    // extractedText is last column
    expect(cols[cols.length - 1]).toBe('');
  });

  it('quotes fields containing commas', () => {
    const csv = buildCsvContent([makeResult({ shortDescription: 'kitchen, bath' })]);
    expect(csv).toContain('"kitchen, bath"');
  });

  it('quotes fields containing double quotes and doubles them (RFC 4180)', () => {
    const csv = buildCsvContent([makeResult({ shortDescription: 'say "hello"' })]);
    expect(csv).toContain('"say ""hello"""');
  });

  it('quotes fields containing newlines', () => {
    const csv = buildCsvContent([makeResult({ shortDescription: 'line1\nline2' })]);
    expect(csv).toContain('"line1\nline2"');
  });

  it('returns only the header row for an empty array', () => {
    const csv = buildCsvContent([]);
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('number');
  });

  it('handles multiple images in order', () => {
    const csv = buildCsvContent([
      makeResult({ number: 1, category: 'kitchen' }),
      makeResult({ number: 2, category: 'bathroom' }),
      makeResult({ number: 3, category: 'exterior' }),
    ]);
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4); // header + 3 rows
    expect(lines[1]).toMatch(/^1,/);
    expect(lines[2]).toMatch(/^2,/);
    expect(lines[3]).toMatch(/^3,/);
  });

  it('includes all 9 columns in each data row', () => {
    const csv = buildCsvContent([makeResult()]);
    // The header has exactly 8 commas (9 fields)
    const headerCommas = (csv.split('\r\n')[0]?.match(/,/g) ?? []).length;
    expect(headerCommas).toBe(8);
    const dataLine = csv.split('\r\n')[1] ?? '';
    const dataCommas = (dataLine.match(/,/g) ?? []).length;
    expect(dataCommas).toBeGreaterThanOrEqual(8);
  });
});
