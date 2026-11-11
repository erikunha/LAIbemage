---
description: Checks AGENTS.md against the code for documentation drift: Config fixture fields, module boundary tables, provider lists, and architecture descriptions. Use when you suspect the docs are out of sync, after adding new Config fields, or after a provider refactor. NOT for code quality checks (use /review for that).
---

# Sync Docs: AGENTS.md against the code

Find and fix every place where `AGENTS.md` claims something the code no longer does.

`AGENTS.md` is the single canonical instructions file for this repository. `CLAUDE.md` and
`.github/copilot-instructions.md` are thin runtime-specific pointers to it, so there is no
second copy to keep in sync. The drift that matters is between the doc and the code.

## 1. Config fixture against the Config type

The `makeConfig()` block in `AGENTS.md` must list every REQUIRED field of the `Config`
interface, with the same default.

```bash
node scripts/check-doc-drift.mjs
```

The check compares the documented `makeConfig()` fixture against the `Config` interface in
`packages/core/src/config/index.ts` (not in `types.ts`). It exits non-zero and names the
fields when a REQUIRED field of the type is missing from the fixture, or when the fixture
sets a field the type no longer declares. Optional fields are not reported as missing: the
fixture ends with `...overrides` and legitimately omits them.

For each field it reports, add it to `makeConfig()` with the default the type or the loader
declares, or remove it if the field is gone from the type.

## 2. Module boundary table against the enforcement

The table in `AGENTS.md` must match what the repository actually enforces.

```bash
grep -A 200 "Module boundaries" AGENTS.md | grep "^|" > /tmp/agents_boundaries.txt
grep -n "no-restricted-imports\|restricted" eslint.config.js | head -40
node scripts/check-boundaries.mjs
```

`scripts/check-boundaries.mjs` is the enforcement. A row in the table that the enforcement
does not back is a claim the doc cannot make. A boundary the enforcement has but the table
omits is a hole in the doc.

## 3. Provider list against the code

```bash
grep -E "openai|anthropic|google|azure|ollama|bedrock|vertex" AGENTS.md | sort -u
grep -n "export type LLMProvider" -A 10 packages/core/src/config/index.ts
grep -rn "DEFAULT_MODEL" packages/core/src/config/index.ts | head
```

The provider names, the default model per provider, and the set of providers that support
`--async` must match the code.

## 4. Architecture claims against the code

```bash
grep -n "client.ts\|providers/" AGENTS.md
grep -rn "^import.*from.*openai\|^import.*from.*@anthropic\|^import.*from.*@google" packages/core/src/analyzer/ --include="*.ts"
```

Flag any claim in `AGENTS.md` that contradicts what the code actually does.

## 5. Canonical agent roles against the doc

The canonical roles live at `.agents/agents/<role>.md`; the Claude and Copilot copies are
generated from them. Check the canonical role, never a generated copy.

```bash
diff <(grep "^|" .agents/agents/contributor.md | tail -n +3) <(grep "^|" AGENTS.md | tail -n +3)
pnpm exec tsx scripts/generate-agent-surface.ts --check
```

`tail -n +3` drops the header row and the separator row: the two tables may name their columns
differently, so only the DATA rows are comparable. The role carries a SHORT SUMMARY of the
boundary rules, not a copy of the canonical table, so a non-empty diff is the SIGNAL, not a
failure: read it and judge whether every boundary the role names is still true in
`AGENTS.md`, and whether the role omits a boundary that now matters. Fix the ROLE when the
canonical table is right and the role is stale; fix `AGENTS.md` when the canonical table is
the one that drifted.

## Output

For each drift found, output the exact edit needed:

```
### Fix: AGENTS.md Config fixture missing fields

Add to AGENTS.md makeConfig() after line N:
  azureEndpoint: '',
  azureApiKey: '',
  ...

### Fix: AGENTS.md boundary table missing row

Add to module boundary table:
| `packages/core/src/analyzer/providers/*.ts` | ... | ... |
```

Apply all fixes directly. Do not prompt for confirmation on documentation-only changes.
