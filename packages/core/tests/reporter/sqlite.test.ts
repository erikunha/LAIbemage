import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSqlite } from '../../src/reporter/sqlite.js';
import type { AnalysisCache, ProcessedResult } from '../../src/types.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-test-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeResult(overrides: Partial<ProcessedResult> = {}): ProcessedResult {
  return {
    originalFile: 'IMG_001.jpeg',
    outputFile: '001. Photo of kitchen dated 15-01-2024.jpeg',
    category: 'kitchen',
    number: 1,
    shortDescription: 'clean kitchen',
    elements: ['sink', 'tiles'],
    confidence: 0.9,
    extractedText: null,
    timestamp: 1705312800000,
    ...overrides,
  };
}

function makeCache(images: ProcessedResult[] = [makeResult()]): AnalysisCache {
  return {
    schemaVersion: 1,
    processedDate: '2024-01-15T10:00:00.000Z',
    totalImages: images.length,
    categories: ['kitchen'],
    categoriesHash: 'abc123',
    images,
  };
}

describe('writeSqlite', () => {
  it('creates all required tables', async () => {
    await writeSqlite(makeCache(), dbPath);

    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as { name: string }).name);
    db.close();

    expect(tables).toContain('runs');
    expect(tables).toContain('images');
    expect(tables).toContain('elements');
    expect(tables).toContain('image_links');
    expect(tables).not.toContain('defects');
  });

  it('inserts the run record with correct values', async () => {
    await writeSqlite(makeCache(), dbPath);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM runs').get() as Record<string, unknown>;
    db.close();

    expect(row.processed_date).toBe('2024-01-15T10:00:00.000Z');
    expect(row.schema_version).toBe(1);
    expect(row.total_images).toBe(1);
    expect(row.categories_hash).toBe('abc123');
  });

  it('inserts image record with core field values', async () => {
    await writeSqlite(makeCache(), dbPath);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM images').get() as Record<string, unknown>;
    db.close();

    expect(row.category).toBe('kitchen');
    expect(row.confidence).toBeCloseTo(0.9);
    expect(row.original_file).toBe('IMG_001.jpeg');
    expect(row.short_description).toBe('clean kitchen');
    expect(row.timestamp_ms).toBe(1705312800000);
  });

  it('inserts a row for each element', async () => {
    await writeSqlite(makeCache([makeResult({ elements: ['sink', 'tiles', 'cabinet'] })]), dbPath);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT element FROM elements').all() as { element: string }[];
    db.close();

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.element)).toEqual(
      expect.arrayContaining(['sink', 'tiles', 'cabinet']),
    );
  });

  it('inserts image_links rows for relatedImages', async () => {
    await writeSqlite(
      makeCache([makeResult({ relatedImages: [{ number: 2, relation: 'same_location' }] })]),
      dbPath,
    );

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM image_links').get() as Record<string, unknown>;
    db.close();

    expect(row.image_a).toBe(1);
    expect(row.image_b).toBe(2);
    expect(row.relation).toBe('same_location');
  });

  it('stores null for extractedText when absent', async () => {
    await writeSqlite(makeCache([makeResult({ extractedText: null })]), dbPath);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT extracted_text FROM images').get() as Record<string, unknown>;
    db.close();

    expect(row.extracted_text).toBeNull();
  });

  it('stores extractedText when present', async () => {
    await writeSqlite(makeCache([makeResult({ extractedText: 'WARNING: wet floor' })]), dbPath);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT extracted_text FROM images').get() as Record<string, unknown>;
    db.close();

    expect(row.extracted_text).toBe('WARNING: wet floor');
  });

  it('writes multiple images with distinct numbers', async () => {
    await writeSqlite(
      makeCache([
        makeResult({ number: 1 }),
        makeResult({ number: 2, originalFile: 'IMG_002.jpeg' }),
      ]),
      dbPath,
    );

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT number FROM images ORDER BY number').all() as {
      number: number;
    }[];
    db.close();

    expect(rows.map((r) => r.number)).toEqual([1, 2]);
  });
});
