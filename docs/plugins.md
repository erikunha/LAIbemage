# Plugin System

Vision Lens ships a lifecycle hook API that lets you run custom logic at three points in a run without modifying the CLI source or forking the project.

---

## How plugins work

- Plugins are `.mjs` files loaded at runtime via `--plugin <path>`.
- The flag is repeatable — multiple plugins can be loaded in one run.
- Each hook is optional; implement only what you need.
- A plugin that throws never aborts the run — the error is logged as a warning and the hook is skipped for that image.

```bash
vision-lens --plugin ./plugins/slack-notify.mjs --plugin ./plugins/db-write.mjs
```

---

## Interface

A plugin file must `export default` an object matching this shape (TypeScript reference):

```typescript
interface Plugin {
  /** Human-readable name used in log messages. */
  readonly name: string;

  /** Called after each image is analysed by the LLM. */
  onImageAnalysed?(result: AnalyzedImage): Promise<void>;

  /** Called after each image is processed (overlay stamped, JPEG exported). */
  onImageProcessed?(result: ProcessedResult): Promise<void>;

  /** Called once after the full run completes and the cache has been written atomically. */
  onRunComplete?(cache: AnalysisCache): Promise<void>;
}
```

### Hook call order

```
For each batch of images:
  1. LLM analysis completes → onImageAnalysed(analyzedImage)
     └─ category is the raw LLM output — not yet adjusted by temporal consensus

After all batches complete:
  2. Temporal consensus voting  (may change categories)
  3. Self-critique pass         (may reclassify, if --self-critique)
  4. Cross-image linking        (adds relatedImages, if --link)

For each image (in final sorted order):
  5. JPEG processed + renamed → onImageProcessed(processedResult)
     └─ category and relatedImages are final here

After all images:
  6. analysis_results.json written atomically → onRunComplete(cache)
```

---

## Payload types

### `AnalyzedImage` (passed to `onImageAnalysed`)

```typescript
interface AnalyzedImage {
  file: string;        // original filename
  fullPath: string;    // absolute path to the source file
  createdAt: number;   // ms since Unix epoch (EXIF or filesystem fallback)
  exifSource: 'exif' | 'birthtime' | 'ctime';
  analysis: {
    category: string;
    shortDescription: string;
    fullDescription: string;   // max 250 chars; empty string if the LLM returned none
    elements: string[];
    confidence: number;        // 0.0–1.0
    extractedText: string | null;
  };
}
```

### `ProcessedResult` (passed to `onImageProcessed`)

```typescript
interface ProcessedResult {
  originalFile: string;
  outputFile: string;           // renamed output filename
  category: string;
  number: number;               // sequence number in the run
  shortDescription: string;
  fullDescription?: string;     // absent in pre-existing caches written before this field was added
  elements: string[];
  confidence: number;
  extractedText: string | null;
  timestamp: number;
  sessionId?: string;           // set if --session-gap was used; groups images into shooting sessions
  lowConsensus?: boolean;       // true if two providers disagreed (--consensus-providers)
  relatedImages?: Array<{ number: number; relation: string }>;
}
```

### `AnalysisCache` (passed to `onRunComplete`)

```typescript
interface AnalysisCache {
  schemaVersion: number;
  processedDate: string;        // ISO 8601
  totalImages: number;
  categories: string[];
  categoriesHash: string;       // SHA-256 (12 hex) of sorted category names
  images: ProcessedResult[];
  sessions?: Array<{            // present if --session-gap was used
    id: string;
    imageNumbers: number[];
    startTime: number;
    endTime: number;
  }>;
  pluginApiVersion?: number;
  overrides?: ReviewOverride[];
  skipped?: string[];
}
```

---

## Versioning contract

`PLUGIN_API_VERSION` is exported from the package and is currently `1`.

Plugins that depend on a specific API shape should assert this at load time:

```javascript
import { PLUGIN_API_VERSION } from '@vision-lens/sdk';

if (PLUGIN_API_VERSION !== 1) {
  throw new Error(`my-plugin requires PLUGIN_API_VERSION=1, got ${PLUGIN_API_VERSION}`);
}
```

When a breaking change to the `Plugin` interface is made, `PLUGIN_API_VERSION` will be incremented and the change documented in `CHANGELOG.md`.

---

## Example: Slack notification on run complete

```javascript
// plugins/slack-notify.mjs
const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export default {
  name: 'slack-notify',

  async onRunComplete(cache) {
    if (!WEBHOOK_URL) return;

    const unknown = cache.images.filter(i => i.category === 'unknown').length;
    const text = [
      `*Vision Lens run complete*`,
      `• ${cache.totalImages} images processed`,
      `• ${cache.totalImages - unknown} classified, ${unknown} unknown`,
      `• Categories: ${cache.categories.join(', ')}`,
    ].join('\n');

    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  },
};
```

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
  vision-lens --plugin ./plugins/slack-notify.mjs
```

---

## Example: Write results to a database

```javascript
// plugins/db-write.mjs
import { createClient } from '@libsql/client';

const db = createClient({ url: process.env.DATABASE_URL });

export default {
  name: 'db-write',

  async onImageProcessed(result) {
    await db.execute({
      sql: `INSERT OR REPLACE INTO images
              (file, category, confidence, description, processed_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        result.originalFile,
        result.category,
        result.confidence,
        result.shortDescription,
        new Date().toISOString(),
      ],
    });
  },
};
```

---

## Example: Per-image webhook (CI integration)

```javascript
// plugins/webhook.mjs
const ENDPOINT = process.env.WEBHOOK_ENDPOINT;

export default {
  name: 'webhook',

  async onImageAnalysed(image) {
    if (!ENDPOINT) return;
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'image_analysed',
        file: image.file,
        category: image.analysis.category,
        confidence: image.analysis.confidence,
      }),
    });
  },
};
```

---

## Tips

- **Plugins are isolated.** A thrown error is caught and logged; it never propagates to the run.
- **Plugins are loaded in order.** Hooks on the same event fire in the order `--plugin` flags appear.
- **`onImageAnalysed` sees the raw LLM category.** It fires before temporal consensus and self-critique, so the category may still change. Use `onImageProcessed` if you need the final, corrected category.
- **Use `onRunComplete` for aggregates.** All per-image data is available in `cache.images`; this is the right place for summaries, uploads, or report generation.
- **The SDK exports `PLUGIN_API_VERSION`.** Import it to guard against future breaking changes.
- **`sessionId` groups burst sessions.** If `--session-gap` was used, images in `cache.images` will have a `sessionId` field. Use it to group related images in your output.
