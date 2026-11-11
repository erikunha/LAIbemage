---
description: Checks CLAUDE.md against AGENTS.md for documentation drift — Config fixture fields, module boundary tables, provider lists, and architecture descriptions. Use when you suspect the two files are out of sync, after adding new Config fields, or after a provider refactor. NOT for code quality checks (use /review for that).
---

# Sync Docs — CLAUDE.md ↔ AGENTS.md Drift Check

Find and fix all documentation drift between `CLAUDE.md` and `AGENTS.md`. These two files must stay in sync — AGENTS.md is the authoritative source when they differ.

## 1 — Config fixture diff

Extract and compare the `makeConfig()` blocks from both files.

```bash
grep -A 100 "function makeConfig" CLAUDE.md | grep -E "^\s+\w+:" | sed 's/^\s*//' | sort > /tmp/claude_fields.txt
grep -A 100 "function makeConfig" AGENTS.md | grep -E "^\s+\w+:" | sed 's/^\s*//' | sort > /tmp/agents_fields.txt
diff /tmp/claude_fields.txt /tmp/agents_fields.txt
```

For each field in AGENTS.md but missing from CLAUDE.md: add it to `CLAUDE.md` with the same default value.
For each field in CLAUDE.md but missing from AGENTS.md: flag it for manual review (may be intentional, may be stale).

## 2 — Module boundary table

Extract the boundary table from both files and compare row counts and content:

```bash
grep -A 200 "Module boundaries" CLAUDE.md | grep "^|" > /tmp/claude_boundaries.txt
grep -A 200 "Module boundaries" AGENTS.md | grep "^|" > /tmp/agents_boundaries.txt
diff /tmp/claude_boundaries.txt /tmp/agents_boundaries.txt
```

AGENTS.md is authoritative. Add any missing rows to CLAUDE.md. Flag contradicting rows.

## 3 — Provider list consistency

Check that the same set of providers appears in both files:
- `LLMProvider` union entries
- Default model table
- Supported providers for `--async`

```bash
grep -E "openai|anthropic|google|azure|ollama|bedrock|vertex" CLAUDE.md | sort -u
grep -E "openai|anthropic|google|azure|ollama|bedrock|vertex" AGENTS.md | sort -u
```

## 4 — Architecture claim validation

Check CLAUDE.md for claims that contradict the actual code structure:

```bash
# Verify the client.ts / providers/ claim matches reality
grep -n "client.ts\|providers/" CLAUDE.md
grep -rn "^import.*from.*openai\|^import.*from.*@anthropic\|^import.*from.*@google" packages/core/src/analyzer/ --include="*.ts"
```

Flag any claim in CLAUDE.md that contradicts what the code actually does.

## 5 — Contributor agent alignment

Check that `contributor.md` reflects current AGENTS.md module boundary table:

```bash
diff <(grep "^|" .claude/agents/contributor.md) <(grep "^|" AGENTS.md | head -20)
```

## Output

For each drift found, output the exact edit needed:

```
### Fix: CLAUDE.md Config fixture missing fields

Add to CLAUDE.md makeConfig() after line N:
  azureEndpoint: '',
  azureApiKey: '',
  ...

### Fix: CLAUDE.md boundary table missing row

Add to module boundary table:
| `packages/core/src/analyzer/providers/*.ts` | ... | ... |
```

Apply all fixes directly. Do not prompt for confirmation on documentation-only changes.
