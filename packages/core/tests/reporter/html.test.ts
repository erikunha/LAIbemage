import { describe, expect, it } from 'vitest';
import { escapeHtml, generateHtmlReport } from '../../src/reporter/html.js';
import type { AnalysisCache } from '../../src/types.js';
import { CACHE_SCHEMA_VERSION } from '../../src/types.js';

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's fine")).toBe('it&#x27;s fine');
  });

  it('passes through safe text unchanged', () => {
    expect(escapeHtml('Hello world 123')).toBe('Hello world 123');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes multiple special chars in one string', () => {
    const input = `<div class="x" data-val='y'> & </div>`;
    const output = escapeHtml(input);
    expect(output).not.toContain('<');
    expect(output).not.toContain('>');
    expect(output).not.toContain('"');
    expect(output).not.toContain("'");
    expect(output).not.toContain('&d'); // raw & (only &amp; allowed)
    expect(output).toContain('&lt;');
    expect(output).toContain('&gt;');
    expect(output).toContain('&quot;');
    expect(output).toContain('&#x27;');
    expect(output).toContain('&amp;');
  });
});

// ---------------------------------------------------------------------------
// generateHtmlReport
// ---------------------------------------------------------------------------

function makeCache(overrides: Partial<AnalysisCache> = {}): AnalysisCache {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    processedDate: '2024-01-15T10:00:00.000Z',
    totalImages: 2,
    categories: ['kitchen', 'bathroom'],
    categoriesHash: 'abc123def456',
    images: [
      {
        originalFile: 'IMG_001.jpeg',
        outputFile: '001. Photo of kitchen dated 15-01-2024.jpeg',
        category: 'kitchen',
        number: 1,
        shortDescription: 'water damage above sink',
        elements: ['sink', 'water damage'],
        confidence: 0.9,
        extractedText: null,
        timestamp: 1705312800000,
      },
      {
        originalFile: 'IMG_002.jpeg',
        outputFile: '002. Photo of bathroom dated 15-01-2024.jpeg',
        category: 'bathroom',
        number: 2,
        shortDescription: 'mold on tiles',
        elements: ['tiles', 'mold'],
        confidence: 0.95,
        extractedText: null,
        timestamp: 1705312860000,
      },
    ],
    ...overrides,
  };
}

describe('generateHtmlReport', () => {
  it('returns a string starting with <!DOCTYPE html>', async () => {
    const html = await generateHtmlReport(makeCache(), './output');
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('includes strict Content-Security-Policy meta tag', async () => {
    const html = await generateHtmlReport(makeCache(), './output');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("style-src 'unsafe-inline'");
    expect(html).toContain('img-src data:');
    expect(html).toContain("script-src 'none'");
  });

  it('HTML-escapes LLM shortDescription', async () => {
    const cache = makeCache({
      images: [
        {
          originalFile: 'IMG_001.jpeg',
          outputFile: '001. Photo of kitchen dated 15-01-2024.jpeg',
          category: 'kitchen',
          number: 1,
          shortDescription: '<script>alert("xss")</script>',
          elements: [],
          confidence: 0,
          extractedText: null,
          timestamp: 1705312800000,
        },
      ],
    });
    const html = await generateHtmlReport(cache, './output');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('HTML-escapes LLM elements array items', async () => {
    const cache = makeCache({
      images: [
        {
          originalFile: 'IMG_001.jpeg',
          outputFile: '001. Photo of kitchen dated 15-01-2024.jpeg',
          category: 'kitchen',
          number: 1,
          shortDescription: 'normal',
          elements: ['<b>bold</b>', 'sink & drain'],
          confidence: 0,
          extractedText: null,
          timestamp: 1705312800000,
        },
      ],
    });
    const html = await generateHtmlReport(cache, './output');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('sink &amp; drain');
  });

  it('includes a section for each category with images', async () => {
    const html = await generateHtmlReport(makeCache(), './output');
    expect(html).toContain('id="cat-kitchen"');
    expect(html).toContain('id="cat-bathroom"');
  });

  it('includes category navigation badges', async () => {
    const html = await generateHtmlReport(makeCache(), './output');
    expect(html).toContain('href="#cat-kitchen"');
    expect(html).toContain('href="#cat-bathroom"');
  });

  it('shows "no-thumb" placeholder when image file is missing', async () => {
    // outputDir is /nonexistent so image reads will fail
    const html = await generateHtmlReport(makeCache(), '/nonexistent-directory');
    expect(html).toContain('no-thumb');
    expect(html).toContain('Image not found');
  });

  it('displays image count and categories count in header', async () => {
    const html = await generateHtmlReport(makeCache(), '/nonexistent-directory');
    expect(html).toContain('2 images');
    expect(html).toContain('2 categories');
  });

  it('skips sections for categories with no images', async () => {
    const cache = makeCache({
      categories: ['kitchen', 'bathroom', 'exterior'],
      images: [
        {
          originalFile: 'IMG_001.jpeg',
          outputFile: '001.jpeg',
          category: 'kitchen',
          number: 1,
          shortDescription: 'test',
          elements: [],
          confidence: 0,
          extractedText: null,
          timestamp: 1705312800000,
        },
      ],
    });
    const html = await generateHtmlReport(cache, '/nonexistent-directory');
    // exterior has no images — no section for it
    expect(html).not.toContain('id="cat-exterior"');
    expect(html).not.toContain('href="#cat-exterior"');
    // kitchen does have images
    expect(html).toContain('id="cat-kitchen"');
  });

  it('does not contain any inline <script> tags', async () => {
    const html = await generateHtmlReport(makeCache(), '/nonexistent-directory');
    // No real script elements — CSP forbids them anyway
    expect(html).not.toMatch(/<script[\s>]/i);
  });

  it('does not reference any external URLs in src or href', async () => {
    const html = await generateHtmlReport(makeCache(), '/nonexistent-directory');
    // All src attributes should be data: URIs or empty (no http/https)
    const srcMatches = [...html.matchAll(/\bsrc="([^"]+)"/g)].map((m) => m[1]);
    for (const src of srcMatches) {
      expect(src).toMatch(/^data:/);
    }
  });
});
