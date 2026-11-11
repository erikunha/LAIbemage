---
name: write-plugin
description: Use when a developer wants to create an external lifecycle plugin file loaded via --plugin: picking the lifecycle hooks, handling secrets safely, wrapping I/O in try/catch, unit testing the hooks and running the plugin in a dry run.
---

# Skill: Write a Lifecycle Plugin

## When to use this skill

Use when a developer wants to create an external plugin file loaded via `--plugin <path>`.
This skill guides you from zero to a fully working, tested `.mjs` plugin file.

## Overview

Plugins are external `.mjs` files loaded at runtime. They receive structured callbacks
at three lifecycle points: after each image is classified, after each image is processed,
and after the entire run completes.

---

## Steps

### Step 1 — Understand the Plugin interface

Read the current interface definition:

```
packages/core/src/types.ts  →  search for "interface Plugin"
```

Key facts:

- `name: string` is required — it identifies your plugin in logs
- All hooks are **optional** — implement only what you need
- All hooks are `async` and must return `Promise<void>`
- `PLUGIN_API_VERSION` is currently `1` — assert this if your plugin is version-sensitive

### Step 2 — Choose your hooks

| Hook               | Called                   | Receives          | Good for                                        |
| ------------------ | ------------------------ | ----------------- | ----------------------------------------------- |
| `onImageAnalysed`  | After LLM classification | `AnalyzedImage`   | Real-time alerts, streaming results             |
| `onImageProcessed` | After JPEG export        | `ProcessedResult` | File sync, audit logs, post-processing          |
| `onRunComplete`    | Once at end              | `AnalysisCache`   | Summary reports, database writes, notifications |

Choosing too many hooks increases coupling. Start with `onRunComplete` unless you need per-image callbacks.

### Step 3 — Scaffold the file

Create `plugins/<your-plugin-name>.mjs`:

```javascript
// plugins/my-plugin.mjs
// Compatible with PLUGIN_API_VERSION: 1

export default {
  name: 'my-plugin',

  async onImageAnalysed(result) {
    // Access: result.category, result.shortDescription, result.originalFile
    // result.analysedAt (ISO timestamp), result.confidence (if present)
  },

  async onImageProcessed(result) {
    // Access: result.outputFile, result.sequenceNumber, result.category
    // result.timestamp (the red overlay timestamp), result.originalFile
  },

  async onRunComplete(cache) {
    // Access: cache.results (array of all AnalyzedImage)
    // cache.processedFiles, cache.categoriesHash, cache.schemaVersion
  },
};
```

### Step 4 — Handle secrets safely

Never hardcode API keys or URLs. Always use environment variables:

```javascript
async onRunComplete(cache) {
  const webhookUrl = process.env.MY_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[my-plugin] MY_WEBHOOK_URL not set — skipping notification');
    return;
  }
  // ... use webhookUrl
},
```

### Step 5 — Wrap I/O in try/catch

The runtime already catches and logs hook throws, but explicit error handling
gives you control over the log message and allows graceful fallback:

```javascript
async onRunComplete(cache) {
  try {
    await sendWebhook({ total: cache.results.length });
  } catch (err) {
    console.error(`[my-plugin] notification failed: ${err.message}`);
    // Do NOT rethrow — the run has completed successfully
  }
},
```

### Step 6 — Validate the file loads

```bash
node --input-type=module --eval "
import('./plugins/my-plugin.mjs').then(m => {
  const p = m.default;
  console.log('Plugin loaded:', p.name);
  console.log('Hooks:', Object.keys(p).filter(k => k !== 'name'));
})
"
```

### Step 7 — Test with a dry run

```bash
node dist/cli/index.js \
  --input ./input \
  --output ./output \
  --plugin ./plugins/my-plugin.mjs \
  --dry-run
```

Look for:

- `[plugin] Loaded: my-plugin` in the log output
- No errors during hook execution

### Step 8 — Write unit tests

Tests live in `packages/core/tests/plugin/` (for the dispatcher) but plugin-specific logic should be
tested in `packages/core/tests/plugin/`.

Since `.mjs` files cannot be vi.mocked at import time, test the hook functions directly:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Import the default export directly for testing
const plugin = (await import('../../plugins/my-plugin.mjs')).default;

describe('my-plugin', () => {
  it('calls webhook on run complete', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    process.env.MY_WEBHOOK_URL = 'https://example.com/hook';

    await plugin.onRunComplete({ results: [], processedFiles: [] } as any);

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/hook', expect.any(Object));
  });

  it('handles missing env var gracefully', async () => {
    delete process.env.MY_WEBHOOK_URL;
    // Should not throw
    await expect(plugin.onRunComplete({ results: [] } as any)).resolves.toBeUndefined();
  });
});
```

### Step 9 — Use in production

Pass the path (relative to `cwd`) via `--plugin`:

```bash
node dist/cli/index.js \
  --input ./input \
  --output ./output \
  --plugin ./plugins/my-plugin.mjs
```

Multiple plugins are supported:

```bash
  --plugin ./plugins/plugin-a.mjs --plugin ./plugins/plugin-b.mjs
```
