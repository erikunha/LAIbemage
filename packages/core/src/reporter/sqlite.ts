import type { drizzle as DrizzleFn } from 'drizzle-orm/better-sqlite3';
import type { AnalysisCache } from '../types.js';
import { elements, imageLinks, images, runs } from './sqlite-schema.js';

const CREATE_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    processed_date TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    total_images INTEGER NOT NULL,
    categories_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS images (
    run_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    original_file TEXT NOT NULL,
    output_file TEXT NOT NULL,
    category TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    short_description TEXT NOT NULL,
    confidence REAL NOT NULL,
    extracted_text TEXT,
    PRIMARY KEY (run_id, number)
  );
  CREATE TABLE IF NOT EXISTS elements (
    run_id TEXT NOT NULL,
    image_number INTEGER NOT NULL,
    element TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS image_links (
    run_id TEXT NOT NULL,
    image_a INTEGER NOT NULL,
    image_b INTEGER NOT NULL,
    relation TEXT NOT NULL
  );
`;

/** Write an SQLite database to `outPath`. Requires `better-sqlite3` to be installed. */
export async function writeSqlite(cache: AnalysisCache, outPath: string): Promise<void> {
  let Database: new (path: string) => import('better-sqlite3').Database;
  let drizzle: typeof DrizzleFn;
  try {
    [{ default: Database }, { drizzle }] = await Promise.all([
      import('better-sqlite3') as Promise<{
        default: new (path: string) => import('better-sqlite3').Database;
      }>,
      import('drizzle-orm/better-sqlite3') as Promise<{ drizzle: typeof DrizzleFn }>,
    ]);
  } catch {
    throw new Error(
      'better-sqlite3 is not installed. Run `pnpm add better-sqlite3` and try again.',
    );
  }

  const sqlite = new Database(outPath);
  sqlite.exec(CREATE_TABLES_DDL);

  const db = drizzle(sqlite);
  const runId = cache.processedDate;

  db.insert(runs)
    .values({
      id: runId,
      processedDate: cache.processedDate,
      schemaVersion: cache.schemaVersion,
      totalImages: cache.totalImages,
      categoriesHash: cache.categoriesHash,
    })
    .run();

  for (const img of cache.images) {
    db.insert(images)
      .values({
        runId,
        number: img.number,
        originalFile: img.originalFile,
        outputFile: img.outputFile,
        category: img.category,
        timestampMs: img.timestamp,
        shortDescription: img.shortDescription,
        confidence: img.confidence,
        extractedText: img.extractedText ?? null,
      })
      .run();

    for (const element of img.elements) {
      db.insert(elements).values({ runId, imageNumber: img.number, element }).run();
    }

    for (const link of img.relatedImages ?? []) {
      db.insert(imageLinks)
        .values({
          runId,
          imageA: img.number,
          imageB: link.number,
          relation: link.relation,
        })
        .run();
    }
  }

  sqlite.close();
}
