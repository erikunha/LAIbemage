---
name: tech-debt-tracker
description: Scan codebases for technical debt, score severity, track trends. Use when the user mentions tech debt or cleanup sprints.
disable-model-invocation: true
---

# Tech Debt Tracker

Identify, score, prioritize and track technical debt across a codebase, and prove a
cleanup sprint actually reduced it.

## Inputs

- A codebase path to scan.
- Dated inventory snapshots (`debt_YYYY-MM-DD.json`) for trend reporting.
- Team size and sprint capacity for backlog allocation.

## Automation

All paths relative to this skill folder. The scanner's JSON output feeds the prioritizer
directly; dated inventory snapshots feed the dashboard.

| Script | Command | Produces |
| --- | --- | --- |
| `scripts/debt_scanner.py` | `python3 scripts/debt_scanner.py <codebase> --format json --output debt_inventory.json` | `scan_metadata`, `summary`, `debt_items[]`, `file_statistics`, `recommendations` |
| `scripts/debt_prioritizer.py` | `python3 scripts/debt_prioritizer.py debt_inventory.json --framework wsjf --team-size 6 --sprint-capacity 20 --format json --output debt_priorities.json` | `prioritized_backlog`, `sprint_allocation`, `insights` |
| `scripts/debt_dashboard.py` | `python3 scripts/debt_dashboard.py --input-dir snapshots/ --period monthly --format both --output debt_dashboard` | Trend direction and executive-ready summaries |

Prioritizer frameworks: `cost_of_delay` (default), `wsjf`, `rice`.

## A typical pass

```bash
# 1. Scan (dry run against the bundled sample codebase)
python3 scripts/debt_scanner.py assets/sample_codebase --format json --output debt_inventory.json

# 2. Prioritize: work `prioritized_backlog` top-down, paste `sprint_allocation` into planning
python3 scripts/debt_prioritizer.py debt_inventory.json --framework wsjf \
  --team-size 6 --sprint-capacity 20 --format json --output debt_priorities.json

# 3. Track trends across dated snapshots
python3 scripts/debt_dashboard.py \
  assets/historical_debt_2024-01-15.json assets/historical_debt_2024-02-01.json \
  --period monthly --format both --output debt_dashboard
```

Report the scanner's `summary` counts back.

## Verification loop

After a remediation sprint: re-run the scan, re-run the dashboard with the new snapshot,
and assert the targeted categories' counts dropped. A cleanup that doesn't move the
dashboard is rework, not debt paydown.

## References

| File | Read it when |
| --- | --- |
| [references/debt-frameworks.md](references/debt-frameworks.md) | Classifying a debt item, or checking the pitfalls before committing to a plan |
| [references/debt-classification-taxonomy.md](references/debt-classification-taxonomy.md) | The scanner's category for an item looks wrong |
| [references/prioritization-framework.md](references/prioritization-framework.md) | Choosing between `cost_of_delay`, `wsjf` and `rice`, or defending an ordering |
| [references/stakeholder-communication-templates.md](references/stakeholder-communication-templates.md) | Turning the dashboard into an executive or roadmap conversation |
