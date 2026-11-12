import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  processedDate: text('processed_date').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  totalImages: integer('total_images').notNull(),
  categoriesHash: text('categories_hash').notNull(),
});

export const images = sqliteTable(
  'images',
  {
    runId: text('run_id').notNull(),
    number: integer('number').notNull(),
    originalFile: text('original_file').notNull(),
    outputFile: text('output_file').notNull(),
    category: text('category').notNull(),
    timestampMs: integer('timestamp_ms').notNull(),
    shortDescription: text('short_description').notNull(),
    confidence: real('confidence').notNull(),
    extractedText: text('extracted_text'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.number] })],
);

export const elements = sqliteTable('elements', {
  runId: text('run_id').notNull(),
  imageNumber: integer('image_number').notNull(),
  element: text('element').notNull(),
});

export const imageLinks = sqliteTable('image_links', {
  runId: text('run_id').notNull(),
  imageA: integer('image_a').notNull(),
  imageB: integer('image_b').notNull(),
  relation: text('relation').notNull(),
});
