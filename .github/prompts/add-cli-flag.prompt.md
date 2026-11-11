---
mode: agent
description: Add a new CLI flag end-to-end
---

# Add a new CLI flag

I want to add a new CLI flag to Vision Lens.

**Flag name:** {{FLAG_NAME}} (e.g. `--output-quality`)
**Type:** {{FLAG_TYPE}} (string | number | boolean)
**Default value:** {{DEFAULT_VALUE}}
**Description:** {{FLAG_DESCRIPTION}}
**Environment variable fallback:** {{ENV_VAR}} (e.g. `OUTPUT_QUALITY`)

Please implement end-to-end:

1. Add the field to `RawCliOptions` interface in `src/config/index.ts`
2. Add the field to the `Config` interface in `src/config/index.ts`
3. Wire it up in `loadConfig()` with the priority chain: CLI flag > env var > default
4. Add `.option(...)` to the main command in `src/cli/index.ts`
5. Add it to the options table in `src/cli/help.ts`
6. Pass it through to wherever it will be consumed in `src/`
7. Update `README.md` CLI reference table
8. Write a test verifying the config priority chain (CLI > env > default)
