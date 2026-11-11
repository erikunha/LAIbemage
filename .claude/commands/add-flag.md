# Add CLI Flag

Add a new CLI flag end-to-end. Argument: `$ARGUMENTS` (e.g. `--temporal-window <seconds> - override temporal consensus window`)

## Steps

### 1. Define the flag in `packages/cli/src/index.ts`
Add `.option('--flag-name <value>', 'description', defaultValue)` to the Commander program.
Pass the parsed value through to `runBatch` / `runSingle` / `runReorder` as appropriate.

### 2. Add to `Config` interface in `packages/core/src/config/index.ts`
- All fields must be `readonly`
- Use a specific type (not `string` for enums — use a union)
- Add Zod validation if the field comes from a file (not needed for simple CLI primitives)

### 3. Wire in `loadConfig()` in `packages/core/src/config/index.ts`
- Add a `resolveXxx()` helper for any validation/clamping logic (see `resolveDedupeThreshold` as a pattern)
- Wire as: `flagName: resolveXxx(cliOptions.flagName) ?? process.env['FLAG_NAME'] ?? default`
- If the flag points to a file path or has startup-time constraints (e.g. must exist), also validate in `validateStartup()`

### 3a. Add to `packages/cli/src/help.ts` options table
Every CLI flag must appear in the help table. Add a row with the flag name, type, and description.

### 4. Use the flag in the relevant module
Pass `config.flagName` to the function that needs it. Do NOT read `process.argv` directly.

### 5. Update `makeConfig()` in tests
Add the new field to every `makeConfig()` helper in `packages/core/tests/`. TypeScript will flag missing ones.

Required fixture template reminder — include ALL required fields:
```typescript
function makeConfig(): Config {
  return {
    // ... existing fields ...
    flagName: defaultValue,  // ← add here
    concurrency: 1,
    estimate: false,
    temporalWindowMinutes: 5,
    consensusThreshold: 0.6,
    dedupeThreshold: 0,
  };
}
```

### 6. Write a test
In the appropriate test file under `packages/core/tests/`, add:
- Happy path: flag enabled
- Edge case: boundary value or invalid input
- Default behavior: flag omitted

### 7. Verify
```bash
pnpm run typecheck
pnpm test
pnpm run lint
```

### 8. Update `CLAUDE.md`
If the flag changes observable behavior or architecture, add a note under the relevant section.
