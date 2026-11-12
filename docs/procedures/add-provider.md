# Add an LLM provider

Covers extending Vision Lens with a new LLM vision provider end to end: the SDK dependency, the
provider factory, the CLI key flag, quota error detection and the matching tests. Use it when a
provider such as Mistral, Cohere or Bedrock must be wired in. The file also carries three
recipes that share the same surface and used to live in separate command guides: adding a plain
CLI flag, adding a new analysis pass, and re-checking documentation drift after a provider
change.

## When to use

- A new LLM provider must be supported (SDK, factory, CLI flag, quota detection, tests)
- The `LLMClient` interface needs a provider-specific capability
- A new CLI flag is needed end to end (see [Adding a plain CLI flag](#adding-a-plain-cli-flag))
- A new LLM analysis pass is needed (see [Adding a new analysis pass](#adding-a-new-analysis-pass))

## Steps

### 1. Gather requirements

- **Provider name:** the string identifier (e.g. `mistral`), must be `lowercase`
- **SDK package:** the npm package (e.g. `@mistralai/mistralai`)
- **Default model:** the default model string (e.g. `mistral-large-latest`)
- **API key env var:** the variable that holds the key (e.g. `MISTRAL_API_KEY`)
- **Vision support:** does the SDK accept image inputs natively?

### 2. Install the SDK

```bash
pnpm add <sdk-package>
```

Add it to `package.json` under `dependencies` (not `devDependencies`).

### 3. Update the config module

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

// Add API key field to Config (readonly, required)
export interface Config {
  // ... existing fields ...
  newProviderApiKey: string;
}

// Add to RawCliOptions (optional)
export interface RawCliOptions {
  // ... existing fields ...
  newProviderApiKey?: string;
}

// Add key validation in loadConfig()
if (config.provider === '<newprovider>' && !config.newProviderApiKey) {
  throw new Error('NEWPROVIDER_API_KEY is required. Get one at https://...');
}
```

If a Zod enum validates the provider string anywhere, add the new value to that enum too. Also
add the key-presence check to `validateStartup()` in `packages/core/src/index.ts`: it rechecks
keys as a belt-and-suspenders guard when `config.provider === '<newprovider>'`.

### 4. Create the provider file

Create `packages/core/src/analyzer/providers/newprovider.ts`. This is the ONLY file that may
import the new provider's SDK (one SDK per file under `providers/`). Use an existing provider
file such as `packages/core/src/analyzer/providers/openai.ts` as the template. The file must
implement the `LLMClient` interface:
`complete(prompt: string, images: ImageInput[], opts: CompleteOptions): Promise<CompleteResult>`.

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

Quota and credit errors must NOT be retried: throw so `withRetry()` from
`packages/core/src/utils/retry.ts` surfaces them immediately (see step 7).

### 5. Wire the factory into the routing layer

In `packages/core/src/analyzer/client.ts`, import `createNewProviderClient` from
`'./providers/newprovider.js'` and add the case to `createLLMClient()`:

```typescript
case '<newprovider>':
  return createNewProviderClient(config);
```

`client.ts` is a thin routing layer: it imports from `./providers/` only and never imports an
LLM SDK directly.

### 6. Update the CLI wiring

In `packages/cli/src/index.ts`, add the key flag:

```typescript
.option('--new-provider-api-key <key>', 'API key for New Provider (or NEWPROVIDER_API_KEY env var)')
```

In `packages/cli/src/help.ts`, add the provider to the PROVIDERS section (and keep the OPTIONS
table in sync with every flag in `index.ts`).

### 7. Update `.env.example` and quota detection

`.env.example`:

```bash
NEWPROVIDER_API_KEY=your_key_here
```

Add the provider's quota error fingerprint to `isQuotaError()` in
`packages/core/src/utils/retry.ts`:

```typescript
// New Provider quota errors
if (message.includes('<provider-specific error text>')) return true;
```

### 8. Update the docs

- Add the new provider to the supported providers list in `AGENTS.md`
- Update the `packages/core/src/analyzer/client.ts` row in the `AGENTS.md` module boundary table
- Add the provider to the provider table in `README.md`
- Keep the provider list, the default model per provider and the set of providers supporting
  `--async` consistent with the code: `grep -n "export type LLMProvider" -A 10 packages/core/src/config/index.ts`
  is the source of truth

### 9. Test

- Add a unit test in `packages/core/tests/analyzer/batch.test.ts` asserting the new provider's
  client is called
- Add an integration test in `packages/core/tests/analyzer/client.contract.test.ts` that passes
  a mock returning a canned response and asserts `analyzeBatch` parses it; mock the `LLMClient`
  interface, do NOT `vi.mock('<sdk-package>')`
- Add `newproviderApiKey: ''` to every `makeConfig()` fixture; TypeScript flags missing ones
- Run:

```bash
pnpm run typecheck && pnpm test && pnpm run lint
```

## Example output (diff summary)

```
packages/core/src/config/index.ts      +15 lines  (new provider type, key, validation)
packages/core/src/analyzer/client.ts   +30 lines  (new factory + case in createLLMClient)
packages/cli/src/index.ts              +2 lines   (new CLI flag)
packages/cli/src/help.ts               +3 lines   (PROVIDERS section entry)
packages/core/src/utils/retry.ts       +2 lines   (quota error detection)
.env.example                          +1 line
```

## Adding a plain CLI flag

The same skeleton without the SDK. Given a flag such as `--temporal-window <minutes>`:

1. Define the flag in `packages/cli/src/index.ts` with `.option('--flag-name <value>', 'description', defaultValue)`
   and pass the parsed value through to `runBatch` / `runSingle` / `runReorder` as appropriate.
2. Add the field to `RawCliOptions` (optional) and to `Config` in
   `packages/core/src/config/index.ts` (all fields `readonly`; use a specific union type for
   enums, never a bare `string`).
3. Wire it in `loadConfig()`: add a `resolveXxx()` helper for any validation or clamping (see
   `resolveDedupeThreshold` for the pattern) and wire as
   `flagName: resolveXxx(cliOptions.flagName) ?? process.env['FLAG_NAME'] ?? default`. If the
   flag has startup-time constraints (e.g. a path that must exist), also validate it in
   `validateStartup()`.
4. Add a row to the OPTIONS table in `packages/cli/src/help.ts`; every CLI flag must appear
   there, and add or update an EXAMPLES entry if the flag is user-facing.
5. Consume `config.flagName` in the module that needs it; never read `process.argv` directly.
6. Add the field to every `makeConfig()` fixture in `packages/core/tests/` (TypeScript flags
   missing ones; do not silence with `as Config`).
7. Write tests: happy path (flag enabled), edge case (boundary or invalid input), default
   behavior (flag omitted). Verify with `pnpm run typecheck && pnpm test && pnpm run lint`.
8. If the flag changes observable behavior or architecture, note it under the relevant section
   of `AGENTS.md`. After any `Config` change, `pnpm run docs:check` verifies the documented
   `makeConfig()` fixture still matches the interface.

## Adding a new analysis pass

For a pass such as condition assessment or damage detection:

1. Add the new output fields to the relevant interface in `packages/core/src/types.ts`.
2. Create `packages/core/src/analyzer/<pass-name>.ts` with the analysis function:
   - Accept an `LLMClient` (the interface from `packages/core/src/analyzer/client.ts`); do NOT
     import any provider SDK directly, and never create clients inside analysis functions
   - May import Sharp only if the pass needs image processing (same rule as `batch.ts` and
     `dedup.ts`)
   - Call `client.complete(prompt, images, opts)` returning
     `CompleteResult { text, tokensUsed }`
   - Validate the LLM JSON response with Zod before accessing fields
3. Wrap the LLM call in `withRetry()` from `packages/core/src/utils/retry.js`.
4. Wire the pass into `analyzeImages()` in `packages/core/src/analyzer/index.ts`; export the
   function if it is reusable.
5. Add the fields to `ProcessedResult` and the cache JSON output in
   `packages/core/src/index.ts`. If `AnalysisCache` or `PartialAnalysisCache` gain fields,
   increment `CACHE_SCHEMA_VERSION` in `packages/core/src/types.ts` and add a migration step in
   `packages/core/src/store/migrate.ts` (see the full checklist in
   [add-category.md](./add-category.md#cache-schema-migration)).
6. Write tests in `packages/core/tests/analyzer/<pass-name>.test.ts`: mock the `LLMClient`
   interface, never an SDK constructor (`vi.fn()` on `LLMClient.complete`).
