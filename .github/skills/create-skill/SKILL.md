# Skill: Create Skill

**Domain:** AI-assisted development meta-tooling for Vision Lens

## When to use this skill

Use this skill when a user wants to:

- Package domain knowledge as a reusable `.github/skills/<name>/SKILL.md`
- Create a step-by-step guide for a repeatable task in this codebase
- Document a workflow so Copilot agents can execute it consistently

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
or capitals. The SKILL.md file must always be named `SKILL.md` (uppercase).

### 3. Structure the SKILL.md

Use this template:

```markdown
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
- Be executable by a Copilot agent without additional context (self-contained)
- Not duplicate logic already in `copilot-instructions.md` — link to it instead

### 5. Register the skill

After creating `.github/skills/<name>/SKILL.md`:

- Add an entry to the `<skills>` section in the project's `.github/copilot-instructions.md` or
  agent instruction files that should invoke it
- Add a line to `README.md` under "Skills" (if a skills section exists)

### 6. Verify

- Read the SKILL.md back and mentally walk through the steps as if you were an agent
- Confirm every file reference exists in the codebase
- Run `pnpm test` to ensure no accidental changes broke anything

## Example output (directory structure)

```
.github/
  skills/
    add-provider/
      SKILL.md    ← the new skill
```
