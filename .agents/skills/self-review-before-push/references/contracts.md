# Review contracts

The routing contract owns a delegation. This file owns the review profile of that
contract: what a review worker carries in each field, how a review brief is
written, and what a review worker gives back.

The contract mechanics, the fourteen field names, the guard and the result
structure live in
[runtime/agent-routing/claude/references/contracts.md](../../../runtime/agent-routing/claude/references/contracts.md)
and in its runtime-neutral sibling
[runtime/agent-routing/generic/references/contracts.md](../../../runtime/agent-routing/generic/references/contracts.md).
Read those for what the machine enforces. This file says what a review changes
inside them.

## Contents

- Review profile
- Worker brief
- Worker return
- Finding contract
- Refutation
- Challenge
- Accepted context
- Dedup

## Review profile

A review launch is a managed contract like any other. The `PreToolUse` guard in
[runtime/agent-routing/claude/hooks/agent-routing-guard.py](../../../runtime/agent-routing/claude/hooks/agent-routing-guard.py)
reads the block and refuses a launch that breaks a rule, so a review is launched
the same way a writer is.

| Field | What a review puts there |
|---|---|
| `TASK-ID` | A stable id for this review track, so a second wave can name the same track and a later round can find its own evidence. |
| `OBJECTIVE` | The review question. One falsifiable question with a decided answer, never a topic. "Does the mutation keep the v3 and the v5 query caches consistent while both are live?" is a question. "Review the frontend" is not. |
| `WHY-DELEGATE` | The isolation or independence this buys: a specialist who did not write the change, a context that does not carry the author's explanation, a track that runs beside its neighbours. "To save context" is not a reason. |
| `SCOPE` | The files, systems and questions in scope, plus the dependencies this track waits for. The dependency list says what must land before this question can be answered. |
| `OUT-OF-SCOPE` | The domains other tracks own, so two workers do not answer the same question, plus the ordinary line that unrelated files are excluded. The non-overlap rule lives here. |
| `ACCEPTED-CONTEXT` | Verified facts, the review context package, and the upstream decisions already taken. Facts already established and paths already ruled out, so the worker does not re-derive them. |
| `MODEL-ROUTE` | The tier the shape of the task calls for. The live routing policy decides the tier, and the contract states the intent rather than asserting which model ran. |
| `TOOLS` | The minimum set. A read-only review needs to read files and run read commands. It does not need a write tool, and asking for one makes the guard derive a read-only role anyway. |
| `WRITE-OWNERSHIP` | `read-only`. A review never writes. The guard derives this for a read-only role, and a read-only role handed a path is refused. |
| `EVIDENCE` | The source priority and the evidence threshold: which source owns each question, and what would not be enough to support a finding. |
| `VALIDATION` | The concrete checks the review runs, each named: a test command, a type check, a script, with the result expected. "Check everything" is refused. |
| `DONE` | The conditions that define completion: the question answered, the evidence attached to every material claim, the candidate findings listed, the unknowns named. |
| `STOP` | The return budget and the time budget, plus the conditions that end the track with a partial return. A worker that does not finish returns what it has. |
| `RETURN` | The exact result structure, every line indented, with the follow-up trigger: the condition under which this worker opens a question for a second wave instead of answering it. |

### Where the seven review semantics land

A review needs seven things the contract does not name. They ride inside the
fields that exist.

| Review semantic | Field | How it is written |
|---|---|---|
| Review question | `OBJECTIVE` | One falsifiable question, answerable with evidence and able to come back as fail. |
| Dependencies | `SCOPE` | The upstream findings or artefacts this track waits for. |
| Non-overlap | `OUT-OF-SCOPE` | The neighbouring questions other tracks own, named. |
| Source priority | `EVIDENCE` | Which source is authoritative for which part of the question. |
| Evidence threshold | `EVIDENCE` | What would not be enough to support a finding. |
| Follow-up trigger | `RETURN` | The condition under which the worker returns a question instead of an answer. |
| Return budget | `STOP` | The size of the answer and the time it may take. |

### Why no field is added

The guard reads field names, and a field name is the interface between a launch
and its refusal. A new name changes what a valid launch is for every host that
reads the block, and a host that does not know the name either refuses the
launch or silently ignores the line.

The repository rule is one declaration, one consumer per host. So the review
semantics are written inside the fourteen names the guard already accepts, and
the return structure, which the guard does not parse, carries the review
sections. That is why a review profile adds no line to the contract block.

## Worker brief

The brief is what the main thread hands a review worker. It carries the
contract fields in prose form, because the worker reads the brief first and the
contract second.

1. **Objective and why it exists.** The question, and what this review decides.
   Say what the answer changes, so the worker knows how much effort a complete
   answer deserves.
2. **Facts already established.** What earlier waves proved, with their
   anchors. What paths were already ruled out and by which evidence. The worker
   starts from these instead of re-deriving them.
3. **Scope and write ownership.** The exact files, systems and questions. The
   ownership is exclusive per file and read-only for the worker.
4. **Constraints.** Review is read-only. No `git add .`, no `-A`, no `--all`.
   Nothing touches `HEAD`, the index, any ref, or the stash. To read another
   review, use `git show <sha>:<path>` or the worktree that review owns, never
   its working tree.
5. **The deliverable.** The return structure below, and nothing else. A worker
   that writes a review document instead of returning evidence has done the
   wrong job.
6. **Acceptance criteria.** What a complete answer looks like: the question
   answered, each material claim anchored, the unknowns named, the follow-up
   stated or absent.
7. **The return format.** The exact structure, so the main thread can merge
   results without parsing prose.
8. **The time budget.** How long the worker may take. A worker that runs out of
   budget returns what it has, marked partial, instead of returning nothing.

## Worker return

The base result structure is the one in the routing contract: twelve lines, plus
the closing `VERDICT` a review carries. A review returns that structure with
three sections added.

The base lines carry the review like this:

| Base line | What a review puts there |
|---|---|
| `STATUS` | `completed`, `partial`, `blocked` or `failed`. |
| `SUMMARY` | The answer to the review question, in one line. |
| `OBSERVATIONS` | Direct facts, each with its anchor: `file:line`, a count with its denominator, a command with its result, or a named reference. |
| `INFERENCES` | Conclusions drawn from those observations, kept separate from them. |
| `CHANGES` | Omitted. A review is read-only. |
| `VALIDATION` | The checks that ran, with the outcome. |
| `ASSUMPTIONS` | Provisional facts used without sufficient evidence. |
| `UNKNOWNS` | What was not established. |
| `UNSURE` | Claims held at low confidence, for the lead to check first. |
| `RISKS` | Residual or newly introduced risks. |
| `BLOCKERS` | What prevented completion. |
| `NEXT ACTION` | One recommendation to the main thread. |

The three sections a review adds:

- `CANDIDATE FINDINGS` carries each candidate as claim, consequence, proof
  anchor and certainty.
- `REFUTED` carries each discarded concern and the evidence that refuted it.
- `FOLLOW-UP` carries `none`, or the next precise question with the evidence
  trigger that opened it and the domain that should own it.

`OBSERVATIONS` stays direct facts. `INFERENCES` stays separate from them, and a
review that mixes the two has lost the distinction the main thread needs.

Two rules keep the return legal:

- Every line of the structure is indented inside `RETURN`. A line at column 0
  whose name is one of the contract fields, `EVIDENCE` or `VALIDATION` among
  them, starts a second field and the launch is refused.
- `VERDICT` stays the last line.

More than twenty-five lines is a signal that the worker returned a review
instead of evidence. The main thread reads the structure, not the essay.

## Finding contract

An accepted finding carries: severity, location or runtime flow, domain, the
technology and version when the version matters, the proof anchor, the observed
behaviour, the expected behaviour, the reproduction or the trigger, the
consequence, the attribution to this change, the certainty, and the smallest
useful direction.

The canonical severity ladder and the proof anchor law live in
[evidence.md](evidence.md). This file does not restate them.

The schema is what the reviewer checks internally, not what the report prints.
A finding reads as a sentence a colleague can act on: what happens, when, on
which input, why it matters, and the smallest change that fixes it. Mechanically
exposing the schema turns a finding into a form, and a form invites filling the
fields rather than proving the claim.

A candidate that has not survived refutation is not a finding. It is a
candidate, and it says so.

## Refutation

Before a candidate finding is accepted, look for the reason it is false. The
refuters to run, in the order that settles cheapest first:

1. An alternative path already handles it.
2. A guard blocks it.
3. The framework guarantees it.
4. A hidden state update resolves it.
5. The repository convention covers it.
6. The requirement was read wrong.
7. The base already behaved this way.
8. A runtime counterexample shows it does not happen.

Discarding a concern is also a claim, and it goes in `REFUTED` with the evidence
that refuted it. A concern with a real consequence needs evidence to discard it,
the same evidence a finding needs to survive.

## Challenge

A consequential surviving finding is attacked by a challenger, not defended by
its author. The brief for the challenger carries three things: the conclusion
under challenge, the evidence it rests on, and the important assumptions it
depends on. It does not carry the argument for the conclusion.

The challenger names the strongest counterexample, the weakest assumption, the
alternative explanation that also fits, and the cheapest discriminating test
that would separate the two. It reports the class the lead should reconcile the
objection into, first match wins: contract gap, actionable, trade-off, noise.

Reconciliation is the lead's work. The class the challenger suggests is input,
not a verdict.

A conclusion gets at most three rounds. After the third, the unresolved
objections go to the maintainer, and a conclusion too large to settle in three
is split.

The role, its remit and the round limit live in
[routing-challenger.md](../../../runtime/agent-routing/claude/agents/routing-challenger.md).

## Accepted context

Before the first wave, the main thread assembles the review context and passes
it to every worker. It carries:

- the pull request, the branch and the commit range
- the correct base, and how it was established
- the changed files
- the product objective and the acceptance criteria
- the product decisions already taken
- the repository rules
- the exact versions known, where a version was pinned
- the invariants the change must respect
- the constraints of the local runtime

What never passes: the whole conversation, the whole master prompt, large dumps.
A worker receives the accepted context plus the inputs its own domain needs.

The packaging mechanism, with the `required_kinds` a track declares and the
`coverage` it reports, is in
[context-packager.md](../../dev-runtime/references/context-packager.md).

## Dedup

Precedence when several reviews could cover the same ground: the review this
project already has, then the specialist for the exact domain, then a generic
review skill. A generic skill runs only when it adds a materially different
lens.

Several review skills reading the same diff produce correlated noise, not
breadth. Five reviewers on one diff is one reading five times.

Agreement needs separate evidence, not separate workers. Three workers that
read the same source are one source seen three times, and that is one
confirmation. The same applies when different tools expose the same message,
when several graph results come from one snapshot, or when the same issue is
repeated across tracks.

Check the decisive evidence before counting the confirmations.
