---
name: create-skill
description: Use when a user wants to package domain knowledge as a reusable skill in this repository, turn a repeatable task into a step-by-step guide, or register a new skill so agent runtimes can discover and load it.
---

# Skill: Create Skill

**Domain:** AI-assisted development meta-tooling for Vision Lens

## When to use this skill

Use this skill when a user wants to:

- Package domain knowledge as a reusable `.agents/skills/<name>/SKILL.md`
- Create a step-by-step guide for a repeatable task in this codebase
- Document a workflow so coding agents can execute it consistently

## Steps

### 1. Gather requirements

Ask the user:

- **What is the skill name?** (must be `kebab-case`, e.g. `add-provider`, `debug-classification`)
- **What domain does it cover?** (one sentence: "How to add a new LLM provider to client.ts")
- **When should it be invoked?** (describe the trigger scenario)
- **What are the steps?** (ask for a rough outline; you will structure them)
- **What is a good success example?** (optional: a before/after diff or sample output)

### 2. Validate naming

The skill directory name must match `/^[a-z][a-z0-9-]*$/`. Reject names with underscores, spaces,
or capitals. The SKILL.md file must always be named `SKILL.md` (uppercase). The frontmatter `name`
must equal the directory name.

### 3. Structure the SKILL.md

The canonical location of every skill is `.agents/skills/<name>/SKILL.md`. The file starts with a
frontmatter block: the runtime reads `description` to decide whether the skill is relevant, and
`name` to identify it. Use this template:

```markdown
---
name: <name>
description: <one sentence, max 1024 chars, naming the trigger that should activate the skill>
---

# Skill: <Title Case Name>

**Domain:** <one-sentence domain description>

## When to use this skill

Use this skill when a user wants to:

- <trigger scenario 1>
- <trigger scenario 2>

## Steps

### 1. <Step title>

<Instructions. Be concrete. Reference actual file paths, function names, type names.>

### 2. <Step title>

...

## Example output

<diff, code snippet, or sample output that shows a successful result>
```

### 4. Apply the rules

Every SKILL.md in this project must:

- Reference actual file paths from `src/`, not generic placeholders
- Include at least one concrete example (diff, code snippet, or output)
- Be executable by a coding agent without additional context (self-contained)
- Not duplicate logic already in `AGENTS.md`: link to it instead
- Stay provider-neutral: never name a vendor directory or a vendor instruction document

### 5. Publish the skill to every runtime

The canonical file under `.agents/skills/` is the single source of truth. Each agent runtime
reaches it through a relative symlink in its own skills directory:

```bash
mkdir -p .agents/skills/<name>
ln -s ../../.agents/skills/<name> .claude/skills/<name>
ln -s ../../.agents/skills/<name> .github/skills/<name>
```

Both symlinks must be relative and must point at exactly `../../.agents/skills/<name>`. Run
`pnpm exec tsx scripts/check-agent-surface.mjs` to verify the layout after publishing.

### 6. Register the skill

After creating `.agents/skills/<name>/SKILL.md`:

- Add an entry to the skill dispatch table in `AGENTS.md` with the trigger that should invoke it
- Add a line to `README.md` under "Skills" (if a skills section exists)

### 7. Verify

- Read the SKILL.md back and mentally walk through the steps as if you were an agent
- Confirm every file reference exists in the codebase
- Run `pnpm exec tsx scripts/check-agent-surface.mjs` and `pnpm test` to ensure nothing broke

## Example output (directory structure)

```
.agents/
  skills/
    <name>/
      SKILL.md                          the canonical skill
.claude/
  skills/
    <name> -> ../../.agents/skills/<name>
.github/
  skills/
    <name> -> ../../.agents/skills/<name>
```
