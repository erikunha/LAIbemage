# Waves, domain matrix and cleanup

The procedure in the skill is a spine. This file is the part that was a prompt:
the waves, the 21 material domains, the complexity bands, the fan-out rules, the
completion gate, the conclusion vocabulary and the cleanup routine.

## Contents

- The six waves
- W0 BOOTSTRAP
- W1 BREADTH
- W2 DEPTH
- W3 VALIDATION AND PRODUCT
- W4 CHALLENGE
- W5 SYNTHESIS
- The 21 material domains
- Complexity bands
- Fan-out rules
- The dedup gate
- The orchestration completeness gate
- The conclusion matrix vocabulary
- The cleanup routine
- Multimodal evidence

## The six waves

The spine, in order. A wave consumes the previous wave's evidence and produces
the next wave's input. A wave never produces findings of its own; it produces
evidence, refutations and open questions.

```
W0 BOOTSTRAP -> W1 BREADTH -> W2 DEPTH -> W3 VALIDATION + PRODUCT -> W4 CHALLENGE -> W5 SYNTHESIS
```

## W0 BOOTSTRAP

Produces: the calibration map, the resolved target, the REVIEW-CONTEXT and the
first draft of the domain matrix.

Cannot: classify a domain it has no evidence about, dispatch a worker, or name
a verdict. It produces questions, not answers.

Consumes: the request, the repository, the running product, the requester's
acceptance criteria.

## W1 BREADTH

Produces: one investigation per material domain, each returning compressed
evidence and at most a few candidate findings, plus the follow-up questions the
specialists could not answer inside their scope.

Cannot: chase its own follow-ups, re-review the same diff from a second angle,
or decide a severity. A specialist that derives into another domain returns a
FOLLOW-UP, it does not expand.

Consumes: the REVIEW-CONTEXT and the domain matrix.

## W2 DEPTH

Produces: the answers to the follow-up questions that W1 raised, on the
dependencies and call paths those questions name.

Cannot: repeat a W1 question that is already answered, or open a third wave of
breadth. If a depth track answers nothing, it is RUN_AND_EMPTY, and it stays.

Consumes: the W1 evidence and the follow-up questions.

## W3 VALIDATION AND PRODUCT

Produces: the deterministic gate results (parallel validators, read-only, each
reporting scope and exact outcome) and the product observations (the running
system, the real journey, the state read back).

Cannot: fix what it found, and it cannot report a green suite as a journey
that was exercised. NOT_RUN is not passed.

Consumes: the change itself, the repository gates, the product.

## W4 CHALLENGE

Produces: the surviving candidate findings, each attacked by a fresh challenger
against its weakest premise, plus the refutations that closed the rest.

Cannot: introduce a new concern of its own. A challenger attacks one conclusion
and informs the decision; it does not decide.

Consumes: the candidate findings and their evidence.

## W5 SYNTHESIS

Produces: the verdict, the findings ready to paste, the material verification
and the material limits.

Cannot: add a finding that no wave produced. Everything written here already
exists in the evidence.

Consumes: the whole run.

## The 21 material domains

Each domain is classified MATERIAL, SUPPORTING, NOT_APPLICABLE or UNKNOWN. The
owner column names the skill that holds the method, when the repository ships
one. A blank owner means the question stays open and the reviewer carries the
method themselves.

| Domain | MATERIAL when | Method owner |
|---|---|---|
| semantic_diff | the change alters meaning, not only text: a behavior, a contract, a default | code-reviewer |
| reachability | a shared module, a public export or a package manifest moves | monorepo-navigator |
| precedent_history | the touched path carries a guard, a workaround or a removed check | git-retro |
| frontend | a component, a render path or a client hook changes | senior-nextjs |
| client_state_url | client state, a store, a context or the URL becomes a source of truth | react-performance |
| server_query_cache | a query, a cache generation or an invalidation path changes | |
| datatable_virtualization | a table, a list, a virtualized surface or its scroll ownership changes | |
| ui_design_system | a primitive, a token or a themed style changes | ui-design-system |
| accessibility | a control, a label, a role or a focus behavior changes | a11y-audit |
| test_quality | a test, a fixture or a mock changes | verification-planner |
| backend_api | a route, a handler, a schema or a serialization changes | api-design-reviewer |
| authorization_security | an identity, a permission, a token or a secret path changes | senior-security |
| codegen_sdk | a generated artifact, a schema-to-SDK step or a generated client changes | strict-api |
| database_transaction | a model, a migration target, a transaction boundary or a query plan changes | postgres-patterns |
| migration_compatibility | a migration, a schema change or a deploy-order concern appears | migration-architect |
| async_queues | a queue, a worker, a retry, a job identity or a schedule changes | error-handling |
| performance | a hot path, a payload, a render count or a query count changes | performance-profiler |
| observability | a log, a metric, a trace, a correlation id or a health signal changes | observability-designer |
| ai_llm | a prompt, a model route, a retrieval step, a tool call or an evaluation changes | claude-api |
| ci_build | a build, a workflow, a cache, a manifest or a lockfile changes | ci-cd-pipeline-builder |
| base_stacked_pr | the target sits on a stack: the real base is not the trunk | pr-review-expert |

UNKNOWN is not a parking place. Resolve it when the answer can change the
scope, and say so in the conclusion matrix when it cannot.

## Complexity bands

The band calibrates how many tracks the run opens. It is not a quota and it
never creates filler: an empty track is worse than no track.

| Band | Shape | Tracks |
|---|---|---|
| T0 | trivial | 0 to 1 |
| T1 | narrow | 2 to 4 |
| T2 | substantial | 5 to 8 primary, plus follow-ups |
| T3 | cross-system | 10 to 18, in waves |
| T4 | broad or high risk | up to the safe budget of the session |

Pick the band from the number of MATERIAL domains, the number of projects the
change touches and the risk of the surfaces involved. A change with eight
material domains and a high risk surface is T3 even when the diff is small.

## Fan-out rules

One falsifiable question per track. A good question names a behavior and a
trigger ("does the outbox send twice inside the retry window?"); "review the
API" is not a question.

The reviewer is a fresh specialist who did not write the change. Two passes of
the same agent are one opinion, not two, so a second pass needs a different
question and a different specialist.

Independent tracks go out in the same message. Dependent tracks wait for the
answer they need.

The main thread keeps the product authority and the cross-source
reconciliation. It does not redo the exploration of each worker.

## The dedup gate

Preference order when more than one skill could answer a track:

1. the review method that belongs to the project or the repository,
2. the specialist whose domain is exactly the track,
3. the generic review skill, and only when it adds a materially different lens.

Five generic reviewers reading the same diff is correlated noise, not
amplitude. Correlation comes from the source, not from the number of agents:
three workers reading the same implementation, or two tools exposing the same
message, are one source, not three confirmations.

## The orchestration completeness gate

Before synthesis, account for every one of these:

- the material domains,
- the tracks planned, the tracks launched, the tracks concluded and the tracks blocked,
- the follow-up questions raised and where each one landed,
- the validators that ran, and the ones that could not run,
- the challengers that returned.

If one material independent question is still unexplored, the session has
capacity, and the answer can change readiness or the findings, launch that
investigation now. Do not stop because the first agents produced plausible
comments.

## The conclusion matrix vocabulary

Every row ends in one of these five states. No row stays blank.

| State | Meaning |
|---|---|
| COMPLETE | the question was answered with evidence, and the answer stands |
| RUN_AND_EMPTY | the track ran, the evidence is sound, and it found nothing |
| NOT_APPLICABLE | the domain does not apply to this change, and that is why |
| BLOCKED | a capability, credential or environment stopped the track, and the reason is named |
| UNKNOWN | the track never ran and no one can say why; this is an open risk, not a pass |

NOT_RUN belongs in a validator's own report, not in this vocabulary. A check
that could not run because a tool was missing is BLOCKED with the reason.

The shape of the conclusion, one row per domain, plus the skills that were
considered. The values below illustrate the shape, not a real review.

```text
READY: NOT READY, 1 blocking finding.
DATA: COMPLETE (the new field is append-only, 6 of 6 writes pass).
CONTRACT: COMPLETE (the ids and the flags match the scripts).
SECURITY: BLOCKED (no browser driver, the image was never opened).
CI: RUN_AND_EMPTY (43 checks, 0 failed).
SKILLS: ran repo-check and lint (2). Not applicable: browser (no driver), perf (not material).
FINDINGS: MAJOR - <file>:<line> - <what is wrong> - <the command output that shows it>
```

## The cleanup routine

The review creates temporary state. All of it goes back to how it was found:

- the negative-control mutation in the code,
- temporary files and scratch scripts,
- generated experiments and their outputs,
- seeded QA data and the fixtures written for a journey,
- browser artifacts, screenshots and traces,
- local processes the review started, including the dev server,
- worktrees created for isolation.

Use `runtime/bin/scratch-worktree.py` for isolation when a track needs to write
outside the tree under review.

The rule that overrides convenience: preserve the unrelated state of the
developer. Untracked work that was there before the review is still there after
it. If the review and the developer both touched the same path, the
developer's change wins and the review reports the collision.

## Multimodal evidence

A capture has to be opened and described by whoever reads it. Measured
geometry is not looking: a bounding box, a computed layout or a color value
does not tell the reader what the screen shows. A pixel diff is not looking
either: it says two images differ, not which one is wrong.

A capture written to disk and never opened is BLOCKED, not PASS. The same
applies to a screenshot described by a tool that only measured it.
