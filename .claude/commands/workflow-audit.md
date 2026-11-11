---
description: Audits the AI-assisted development workflow for this project — checks agent roster, slash commands, settings, hooks, permission scope, and documentation consistency. Use when asked to review the AI workflow, agents, skills, settings, or the development setup itself. NOT for code quality or CI checks (use /review for that).
---

# AI Workflow Audit

Audit the complete AI-assisted development setup for Vision Lens. Output a structured report with findings and priority-ranked fixes.

## 1 — Agent roster check

List all files in `.claude/agents/` and compare against the roster in `AGENTS.md`:
- Identify any agents in `.claude/agents/` not documented in `AGENTS.md`
- Identify any agents documented in `AGENTS.md` but missing the `.md` file
- Check each agent file for: correct frontmatter (name, description, model, tools), clear trigger condition in description, scoped tool list (read-only agents should not have Write/Edit)

## 2 — Slash command / skill audit

List all files in `.claude/commands/`:
- Verify each has frontmatter with a `description` field (prevents false AI triggering)
- Check the description scopes the trigger precisely (not too broad, not too narrow)
- Verify `$ARGUMENTS` is used where the command needs a path or target
- Check for commands that duplicate agent functionality (if so, note the overlap)

## 3 — Settings audit

Read `.claude/settings.json` and `.claude/settings.local.json`:

**settings.json** (committed, shared):
- `skipPermissions` should NOT be `true` in the committed file — flag if present
- Allow-list should cover the normal dev workflow (`pnpm run *`, `git *`, `npx vitest *`)
- Deny-list should block destructive operations (`rm -rf`, `git reset --hard`)
- PostToolUse hooks should be scoped (e.g., typecheck only on `.ts`/`.tsx` files)

**settings.local.json** (untracked, machine-specific):
- `Read` permissions should be scoped to the project or at most the workspace, not the whole home directory
- Permissions that duplicate `settings.json` should be noted

## 4 — Hook health check

For each hook in `settings.json` and `settings.local.json`:
- Check the command actually exists (e.g., `which semgrep`, `which pnpm`)
- Check any referenced paths exist (log directories, config files)
- Flag hooks that silently fail (tools that aren't installed, missing directories)

Run: `which semgrep 2>/dev/null && echo "ok" || echo "MISSING: semgrep"`

## 5 — Instruction doc drift

Compare `CLAUDE.md` vs `AGENTS.md` for:
- **Config fixture**: run a diff of the `makeConfig()` blocks — flag any fields in one but not the other
- **Module boundary table**: check all rows match between both files
- **Provider list**: verify provider entries are consistent
- **Architecture claims**: flag any claim in CLAUDE.md that contradicts AGENTS.md

Quick diff command:
```bash
grep -A 60 "makeConfig" CLAUDE.md | grep "^\s\+\w" | sort > /tmp/claude_config.txt
grep -A 60 "makeConfig" AGENTS.md | grep "^\s\+\w" | sort > /tmp/agents_config.txt
diff /tmp/claude_config.txt /tmp/agents_config.txt
```

## 6 — Global skills vs project usage

From the system's available skill list, identify:
- Skills that overlap with project agents (same responsibility, different invocation path)
- Useful global skills that could benefit this project but aren't wired in
- Skills that are irrelevant to this project (TypeScript CLI, no frontend/mobile)

## Output format

```
## Workflow Audit Report — Vision Lens

**Verdict: HEALTHY | NEEDS ATTENTION | ACTION REQUIRED**

### ✅ Healthy
- ...

### ⚠️ Needs attention (non-blocking)
- FINDING: <description>
  FIX: <recommended action>

### 🚫 Action required (blocking)
- FINDING: <description>
  FIX: <specific steps>
  FILE: <path>
```
