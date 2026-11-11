@AGENTS.md

# Claude Code

The canonical instructions for this repository are `AGENTS.md` at the repository root. This file
adds only the Claude Code facts and restates no rule.

- Path-scoped rules load from `.claude/rules/<name>.md`. Each one is generated from the canonical
  rule in `.agents/rules/<name>.md` and carries the `paths:` list Claude Code reads, so a rule
  applies when a matching file is read.
- Project skills live in `.agents/skills/<name>/SKILL.md`. Claude Code reaches them through the
  relative symlinks in `.claude/skills/<name>`, so the same skill is loaded once, from one place.
- Agent roles live in `.agents/agents/<role>.md`. The Claude Code adapter is the generated
  `.claude/agents/<role>.md`.
- After editing a canonical rule or role, regenerate the adapters with `pnpm run agents:rules` and
  `pnpm run agents:surface`, then verify with `pnpm run agents:rules:check` and
  `pnpm run agents:surface:check`. A hand edit of an adapter does not match its canonical source
  and fails the check.
- Personal settings belong in `CLAUDE.local.md` and `.claude/settings.local.json`. Both are
  gitignored.
- The tracked `.claude/settings.json` registers one PostToolUse hook that runs `pnpm run typecheck`
  after an Edit or Write of a TypeScript file. The git hooks (pre-commit, pre-push, commit-msg)
  come from `simple-git-hooks` in `package.json`, not from Claude Code.
