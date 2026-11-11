---
name: adversarial-reviewer
description: Hostile-persona code review, with a dual-pass mode where two independent reviewers must both pass.
license: "MIT"
metadata:
  tier: "STANDARD"
  category: "Engineering / Code Quality"
  dependencies: "None (prompt-only, no external tools required)"
  author: "ekreloff"
  version: "2.10.0"
disable-model-invocation: true
---

# Adversarial Code Reviewer

## Description

Adversarial code review skill that forces genuine perspective shifts through three hostile reviewer personas (Saboteur, New Hire, Security Auditor). Each persona MUST find at least one issue. No "LGTM" escapes. Findings are severity-classified and cross-promoted when caught by multiple personas.

## Quick Start

```
/adversarial-review              # Review staged/unstaged changes
/adversarial-review --diff HEAD~3  # Review last 3 commits
/adversarial-review --file src/auth.ts  # Review a specific file
```

## Review Workflow

Whatever persona runs, four axes are always addressed or explicitly reported
as skipped: security (leakage, injection, credentials), architecture-pattern
conformance (the change follows the codebase's existing patterns), regressions
(code deleted or changed outside the stated intent), and hallucinated
references (every added import, method and library resolves in the project;
verify by lookup, never by plausibility; duplicated functions count here, and
a semantic-duplicate detector beats eyeballing when one is available).

### Step 1: Gather the Changes

Determine what to review based on invocation:

- **No arguments:** Run `git diff` (unstaged) + `git diff --cached` (staged). If both empty, run `git diff HEAD~1` (last commit).
- **`--diff <ref>`:** Run `git diff <ref>`.
- **`--file <path>`:** Read the entire file. Focus review on the full file rather than just changes.

If no changes are found, stop and report: "Nothing to review."

### Step 2: Read the Full Context

For every file in the diff:
1. Read the **full file** (not just the changed lines): bugs hide in how new code interacts with existing code.
2. Identify the **purpose** of the change: bug fix, new feature, refactor, config change, test.
3. Note any **project conventions** from AGENTS.md, .editorconfig, linting configs, or existing patterns.

### Step 3: Run All Three Personas

Execute each persona sequentially, following [Personas](references/personas.md). Each persona MUST produce at least one finding. If a persona finds nothing wrong, it has not looked hard enough. Go back and look again.

**IMPORTANT:** Do not soften findings. Do not hedge. Do not say "this might be fine but...". Either it's a problem or it isn't. Be direct.

### Step 4: Deduplicate and Synthesize

After all three personas have reported:
1. Merge duplicate findings (same issue caught by multiple personas).
2. Promote findings caught by 2+ personas to the next severity level.
3. Classify each surviving finding's confidence (below) and sort it into the
   verified or hypothesis section, never both.
4. Produce the final structured output per [Output and anti-patterns](references/output-and-anti-patterns.md).

## Severity Classification

| Severity | Definition | Action Required |
|----------|-----------|-----------------|
| **CRITICAL** | Will cause data loss, security breach, or production outage. Must fix before merge. | Block merge. |
| **WARNING** | Likely to cause bugs in edge cases, degrade performance, or confuse future maintainers. Should fix before merge. | Fix or explicitly accept risk with justification. |
| **NOTE** | Style issue, minor improvement opportunity, or documentation gap. Nice to fix. | Author's discretion. |

**Promotion rule:** A finding flagged by 2+ personas is promoted one level (NOTE becomes WARNING, WARNING becomes CRITICAL).

## Confidence Classification

Severity says how bad a finding would be; confidence says how sure the
finding is actually true here. Report both, plus the evidence behind the
confidence, for every finding. Never collapse these three into one label.

| Confidence | Definition |
|-----------|-----------|
| **confirmed** | The defect is directly demonstrable by reading the code as written: an exact file, line, and mechanism you can point to (an unparameterized query, a hardcoded credential, a visibly unchecked null dereference). |
| **inferred** | The persona's reasoning is sound but the finding depends on an assumption not directly visible in the reviewed code (concurrent invocation, a caller passing a specific value, a failure mode of an external system). State the unconfirmed assumption explicitly. |

**Evidence** is the exact citation backing the confidence call: a `file:line`
or code snippet for `confirmed`, or the reasoning chain and the specific
unconfirmed assumption for `inferred`. A finding without evidence is not
ready to report.

## Two reviewers, both of whom must pass

One reviewer with three personas still holds one conversation, and every persona
inherits whatever that conversation already believes. For a change that must not
be wrong, run the review twice instead: two reviewers, each spawned with the diff
and the acceptance criteria and nothing else, neither shown the other's findings.

```
round 1   reviewer A and reviewer B, same diff, no shared context
          both pass                     -> done
          either fails                  -> fix, then round 2
round 2   same two reviewers, fresh context, on the fixed diff
round 3   last round. Still failing -> stop and report what is unresolved
```

Both must pass. A single approval is an opinion, and the disagreement between two
independent readings is the finding worth having. The cap of three rounds is the
other half: a loop that can run forever converges on whatever wording satisfies the
reviewer rather than on a correct change, so the third failure ends the loop and
the open findings go to the maintainer.

Each reviewer gets the diff, the acceptance criteria and the conventions. Neither
gets the author's explanation of why the change is fine: that is the sentence the
review exists to test.

## When to Use This

- **Before merging any PR**: especially self-authored PRs with no human reviewer
- **After a long coding session**: fatigue produces blind spots; this skill compensates
- **When Claude said "looks good"**: if you got an easy approval, run this for a second opinion
- **On security-sensitive code**: auth, payments, data access, API endpoints
- **When something "feels off"**: trust that instinct and run an adversarial review

## Cross-References

- Related: `engineering-team/senior-security` for deep security analysis
- Related: `engineering-team/code-reviewer` for general code quality review

## References

- [Features and usage](references/features-and-usage.md) - features, examples, problem solved
- [Personas](references/personas.md) - Saboteur, New Hire, Security Auditor
- [Output and anti-patterns](references/output-and-anti-patterns.md) - report format, verdicts, self-review trap
- [Security audit phases](references/security-audit-phases.md) - load this file for security-sensitive changes (auth, crypto, input parsing, deserialization, file paths, shell, network)
