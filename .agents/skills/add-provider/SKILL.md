---
name: add-provider
description: Use when a user wants to add support for a new LLM vision provider (Mistral, Cohere, Bedrock) to Vision Lens: the SDK dependency, the provider factory, the CLI key flag, API key handling, quota error detection and the matching tests.
---

# Skill: Add LLM Provider

**Domain:** Extending `packages/core/src/analyzer/client.ts` with a new LLM Vision provider

## When to use this skill

Use this skill when a user wants to:

- Add support for a new LLM provider (e.g. Mistral, Cohere, Bedrock)
- Extend the `LLMClient` interface with provider-specific capabilities
- Wire a new provider into the CLI `--provider` flag

## Steps

### 1. Gather requirements

Ask the user:

- **Provider name:** what string identifier? (e.g. `mistral`) — must be `lowercase`
- **SDK package:** what npm package does it use? (e.g. `@mistralai/mistralai`)
- **Default model:** what model string to use by default? (e.g. `mistral-large-latest`)
- **API key env var:** what environment variable holds the key? (e.g. `MISTRAL_API_KEY`)
- **Vision support:** does the SDK support image inputs natively?

### 2. Install the SDK

```bash
pnpm add <sdk-package>
```

Add it to `package.json` under `dependencies` (not `devDependencies`).

### 3. Update `packages/core/src/types.ts` / `packages/core/src/config/index.ts`

In `packages/core/src/config/index.ts`:

```typescript
// Add the provider to the union type
export type LLMProvider = 'openai' | 'anthropic' | 'google' | '<newprovider>';

// Add default model
const DEFAULT_MODEL: Record<LLMProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-opus-4-7',
  google: 'gemini-2.0-flash',
  '<newprovider>': '<default-model>',
};

// Add API key field to Config interface
export interface Config {
  // ... existing fields ...
  newProviderApiKey: string;
}

// Add to RawCliOptions
export interface RawCliOptions {
  // ... existing fields ...
  newProviderApiKey?: string;
}

// Add key validation in loadConfig()
if (config.provider === '<newprovider>' && !config.newProviderApiKey) {
  throw new Error('NEWPROVIDER_API_KEY is required. Get one at https://...');
}
```

### 4. Create `packages/core/src/analyzer/providers/newprovider.ts`

Create a new provider file following the existing pattern. This is the ONLY file that may import the new provider's SDK:

```typescript
import { NewProviderClient } from '<sdk-package>';

function createNewProviderClient(config: Config): LLMClient {
  const sdk = new NewProviderClient({ apiKey: config.newProviderApiKey });

  return {
    async complete(prompt, images, opts) {
      const result = await withRetry(() =>
        sdk.chat({
          model: config.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                ...images.map((img) => ({
                  type: 'image_url' as const,
                  imageUrl: { url: `data:image/jpeg;base64,${img.base64}` },
                })),
              ],
            },
          ],
          maxTokens: opts.maxTokens,
        }),
      );

      return {
        text: extractJson(result.choices[0].message.content ?? ''),
        tokensUsed: result.usage?.totalTokens ?? 0,
      };
    },
  };
}
```

Then wire it into `packages/core/src/analyzer/client.ts` by importing `createNewProviderClient` from `'./providers/newprovider.js'` and adding the new case to `createLLMClient()`:

```typescript
case '<newprovider>':
  return createNewProviderClient(config);
```

### 5. Update the CLI wiring

In `packages/cli/src/index.ts`, add the key flag:

```typescript
.option('--new-provider-api-key <key>', 'API key for New Provider (or NEWPROVIDER_API_KEY env var)')
```

In `packages/cli/src/help.ts`, add the provider to the PROVIDERS section.

### 6. Update `.env.example`

```bash
NEWPROVIDER_API_KEY=your_key_here
```

### 7. Add quota error detection in `packages/core/src/utils/retry.ts`

Add the provider's quota error fingerprint to `isQuotaError()`:

```typescript
// New Provider quota errors
if (message.includes('<provider-specific error text>')) return true;
```

### 8. Update `AGENTS.md`

- Add the new provider to the supported providers list in `AGENTS.md`
- Update the `packages/core/src/analyzer/client.ts` row in `AGENTS.md` module boundary table

### 9. Test

- Add a unit test in `packages/core/tests/analyzer/batch.test.ts` asserting the new provider's client is called
- Run `pnpm run typecheck && pnpm test && pnpm run lint`

## Example output (diff summary)

```
packages/core/src/config/index.ts      +15 lines  (new provider type, key, validation)
packages/core/src/analyzer/client.ts   +30 lines  (new factory + case in createLLMClient)
packages/cli/src/index.ts              +2 lines   (new CLI flag)
packages/cli/src/help.ts               +3 lines   (PROVIDERS section entry)
packages/core/src/utils/retry.ts       +2 lines   (quota error detection)
.env.example                          +1 line
```
