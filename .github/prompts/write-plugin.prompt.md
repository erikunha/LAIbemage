---
mode: insert
description: Scaffold a complete lifecycle plugin for Vision Lens
---

You are scaffolding an external lifecycle plugin for Vision Lens.

Plugin name: {{PLUGIN_NAME}}
Hooks to implement: {{HOOKS}}

## Requirements

1. The file must be a `.mjs` (native ESM) file — NOT TypeScript
2. The default export must be an object with:
   - `name: string` matching `{{PLUGIN_NAME}}`
   - Each hook listed in `{{HOOKS}}` implemented as `async (param) => Promise<void>`
3. All secrets/config must come from `process.env` — never hardcoded
4. Each hook must be wrapped in `try/catch` — log errors with `console.error`, do NOT rethrow
5. Validate required env vars at the start of each hook; log a warning and return early if missing

## Plugin interface reference

```typescript
interface Plugin {
  name: string;
  onImageAnalysed?(result: AnalyzedImage): Promise<void>;
  onImageProcessed?(result: ProcessedResult): Promise<void>;
  onRunComplete?(cache: AnalysisCache): Promise<void>;
}
```

**`AnalyzedImage`** available fields: `originalFile`, `category`, `shortDescription`, `elements`, `condition`, `analysedAt`
**`ProcessedResult`** available fields: `originalFile`, `outputFile`, `sequenceNumber`, `category`, `timestamp`, `shortDescription`
**`AnalysisCache`** available fields: `results` (AnalyzedImage[]), `processedFiles` (string[]), `categoriesHash`, `schemaVersion`

## Generate

1. Produce the full `.mjs` file at path `plugins/{{PLUGIN_NAME}}.mjs`
2. Produce a matching test file at `tests/plugins/{{PLUGIN_NAME}}.test.ts` that:
   - Imports the plugin's default export directly
   - Tests each hook with a minimal mock payload
   - Tests the case where a required env var is missing (should not throw)
   - Tests the case where an I/O call throws (should not propagate)
3. Produce a one-line validation command to verify the plugin loads

## Environment variables

List any `process.env.XYZ` variables the plugin needs, with descriptions, to add to `.env.example`.
