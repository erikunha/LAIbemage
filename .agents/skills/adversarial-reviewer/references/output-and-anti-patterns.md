
## Output Format

Every finding carries three separate fields: **severity** (impact, see
[SKILL.md](../SKILL.md)), **confidence** (`confirmed` or `inferred`), and
**evidence** (the exact citation backing the confidence call). Never collapse
these into one label, and never state a confidence without the evidence that
supports it.

Findings are sorted into exactly one of two sections, never both: **Verified
Findings** (confidence `confirmed`, directly demonstrable from the code as
written) and **Hypotheses** (confidence `inferred`, plausible but resting on
an assumption the review did not confirm). A finding that turns out to rest
on an unconfirmed assumption belongs in Hypotheses even if the persona
initially treated it as certain.

Structure your review as follows:

```markdown
## Adversarial Review: [brief description of what was reviewed]

**Scope:** [files reviewed, lines changed, type of change]
**Verdict:** BLOCK / CONCERNS / CLEAN

### Verified Findings
[Directly demonstrable from the code as written. Empty section reads: "No verified findings."]

- **[CRITICAL/WARNING/NOTE]** [finding] (confidence: confirmed)
  - Evidence: [file:line or code snippet showing the defect]

### Hypotheses
[Plausible failure modes resting on an assumption not confirmed by this review. Empty section reads: "No open hypotheses."]

- **[CRITICAL/WARNING/NOTE]** [finding] (confidence: inferred)
  - Evidence: [the reasoning chain and the specific unconfirmed assumption]

### Summary
[2-3 sentences: what's the overall risk profile? What's the single most important thing to fix?]
```

**Verdict definitions:**
- **BLOCK**: 1+ CRITICAL findings (verified or hypothesis). Do not merge until resolved.
- **CONCERNS**: no criticals but 2+ WARNING findings. Merge at your own risk.
- **CLEAN**: only NOTE findings. Safe to merge.

## Anti-Patterns

### What This Skill is NOT

| Anti-Pattern | Why It's Wrong |
|-------------|---------------|
| "LGTM, no issues found" | If you found nothing, you didn't look hard enough. Every change has at least one risk, assumption, or improvement opportunity. |
| Cosmetic-only findings | Reporting only whitespace/formatting while missing a null dereference is worse than no review at all. Substance first, style second. |
| Pulling punches | "This might possibly be a minor concern...". No. Be direct. "This will throw a NullPointerException when `user` is undefined." |
| Restating the diff | "This function was added to handle authentication" is not a finding. What's WRONG with how it handles authentication? |
| Ignoring test gaps | New code without tests is a finding. Always. Tests are not optional. |
| Reviewing only the changed lines | Bugs live in the interaction between new code and existing code. Read the full file. |

### The Self-Review Trap

You are likely reviewing code you just wrote or just read. Your brain (weights) formed the same mental model that produced this code. You will naturally think it looks correct because it matches your expectations.

**To break this pattern:**
1. Read the code **bottom-up** (start from the last function, work backward).
2. For each function, state its contract **before** reading the body. Does the body match?
3. Assume every variable could be null/undefined until proven otherwise.
4. Assume every external call will fail.
5. Ask: "If I deleted this change entirely, what would break?" If the answer is "nothing," the change might be unnecessary.
