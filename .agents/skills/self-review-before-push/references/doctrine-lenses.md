# Doctrine lenses

A book improves the question. It is never the requirement, and it is never the
anchor of proof.

Three rules govern every lens in this file:

1. **Cite the principle, not a fabricated quote.** Paraphrase what the work
   argues. Never put quotation marks around words the author may never have
   written. A confident invented quote is worse than no citation.
2. **A lens is not authority.** The finding stands on its own technical merit.
   A real defect found through a lens is real because it is a defect.
3. **Drop the lens that does not anchor.** If a lens cannot be tied to a real
   source, it does not enter the review. A well-grounded lens that produced
   nothing is still worth recording as considered.

Each section below gives the source, the question the lens produces, and what
the lens does not authorize.

## Contents

- Software design
- Refactoring smells
- Pragmatism
- Legacy code
- Architecture
- Evolutionary architecture
- Distributed data
- Reliability
- Operations and readiness
- Testing
- TypeScript
- UX and interaction
- Design systems and content
- Security and API design
- Doctrine conflicts
- Where the repository already does this

## Software design

**Source:** John Ousterhout, *A Philosophy of Software Design*.

**Question it produces:** where does the complexity of this change land, and
who pays for it later? A module with a deep interface hides its complexity and
a module with a shallow one spreads it across every caller. A change that
amplifies means every future change in that area costs more than the last. A
change that touches something the reader cannot see creates an unknown unknown,
and an unknown unknown is the cost nobody budgets for. Errors that are
impossible by construction are better than errors that are handled.

**What it does not authorize:** a finding about complexity is not a finding by
itself. It needs the specific mechanism, the specific caller that pays, and the
consequence. "This module is too complex" without the mechanism is a taste
call, and taste is not a finding.

## Refactoring smells

**Source:** Martin Fowler, *Refactoring*, on the catalogue of smells.

**Question it produces:** which smell is present, and what change would remove
it? Duplicated knowledge, divergent change, shotgun surgery, feature envy, data
clumps, primitive obsession and message chains each name a different kind of
structural pressure.

**What it does not authorize:** a smell is a trigger for investigation, never a
finding. Smells describe shape, not behaviour. Nothing is wrong because a
smell is present. The smell is where to look; the finding is what is broken
there, proven by a mechanism.

## Pragmatism

**Source:** Andrew Hunt and David Thomas, *The Pragmatic Programmer*.

**Question it produces:** is this duplication knowledge or coincidence? DRY
applies to knowledge, not to text that happens to look alike. Two pieces of
code that encode the same rule and must change together are one piece of
knowledge written twice. Two pieces that look alike and change independently
are coincidence, and merging them is the error. Orthogonality asks whether two
decisions can change independently. Reversibility asks what it costs to undo
this. A tracer bullet asks how little can be built end to end to prove the
approach. Programming by coincidence is code that works for a reason nobody
wrote down.

**What it does not authorize:** "this should be DRY" is not a finding. The
finding is that a rule is duplicated and will drift, with the two sites and
the rule they encode.

## Legacy code

**Source:** Michael Feathers, *Working Effectively with Legacy Code*.

**Question it produces:** how do you change this safely? Characterization
tests pin the current behaviour before it changes. A seam is a place where
behaviour can be altered without editing the surrounding code. Sensing is
finding where the behaviour actually lives before you touch it. Breaking a
dependency safely means removing one blocking edge, not all of them.

**What it does not authorize:** legacy code is not a defect. Old code that
works and is changing slowly needs no review finding. This lens applies to a
change that touches it, and the finding is about the risk of the change, not
about the age of the code.

## Architecture

**Source:** Mark Richards, Neal Ford and Patrick Kua, *Fundamentals of
Software Architecture*.

**Question it produces:** what are the characteristics this system is supposed
to have, and which boundary, coupling and cohesion decisions produce them?
Where do the decisions live, and who governs them?

**What it does not authorize:** a characteristic nobody declared is not a
violation. The question is always relative to the stated characteristics of
this system, not to an ideal architecture.

## Evolutionary architecture

**Source:** Neal Ford, Rebecca Parsons and Patrick Kua, *Building Evolutionary
Architectures*.

**Question it produces:** how does this architecture change without degrading,
and how would that be noticed? A fitness function is an automated check that
protects an architectural characteristic. Incremental change asks whether this
change can be one step of a sequence, and whether the sequence is planned. An
automated architectural constraint asks whether the rule is enforced by the
build rather than by memory.

**What it does not authorize:** not every system needs fitness functions and
governance machinery. The mechanism is proportional to the local forces. A
repository with three services does not need the apparatus of a large
organisation, and proposing it is scope creep.

## Distributed data

**Source:** Martin Kleppmann, *Designing Data-Intensive Applications*.

**Question it produces:** what is authoritative here, what is derived, and what
can be rebuilt? What is atomic, and what is not? What may go stale, and for how
long? What happens when two writers race, when a retry duplicates a write, and
when an old reader and a new writer coexist during a rolling deploy? The
question is about the boundary between the authoritative state and everything
else that holds a copy of it.

**What it does not authorize:** eventual consistency is not a bug. A system
that documents its consistency model and meets it is correct. The finding is a
documented model that the code does not honour.

## Reliability

**Source:** Michael Nygard, *Release It!*.

**Question it produces:** what happens when a dependency stops answering? A
timeout bounds every wait. Retries without a bound multiply load exactly when
the system is least able to carry it. Resource exhaustion has to be contained
so one failure does not take the rest down. Cascading failure is the normal
shape of a dependency problem. Degradation is a legitimate answer. Recovery
has to be designed, not hoped for.

**What it does not authorize:** none of these mechanisms are required by
default. A local tool with no remote dependency does not need a circuit
breaker, and recommending one is noise.

## Operations and readiness

**Source:** the *Site Reliability Engineering* book.

**Question it produces:** is this service ready to run, and will anyone notice
when it stops? A health signal must be meaningful, so a probe that only
answers when the process is alive says nothing about the service. An objective
indicator must reflect what users experience, and a target must be one the
team can actually be held to. Readiness is a separate question from liveness:
a service that is up but cannot serve traffic is not ready.

**What it does not authorize:** a missing objective indicator is a finding only
when the service already has operational ownership. Adding a full measurement
programme to a change that needs one dashboard is not the scope of the review.

## Testing

**Source:** Gerard Meszaros, *Unit Testing: Principles, Practices, and
Patterns*, and *xUnit Test Patterns*.

**Question it produces:** what behaviour does this test protect, and what defect
would make it fail? A test that cannot detect the defect it exists for is not
evidence. Four properties decide whether a test earns its place: it protects
against regression, it resists refactoring, it gives fast feedback, and it
costs little to keep. The pattern catalogue names the fixtures that provide
realistic data, the doubles that stand in for collaborators, the isolation that
keeps a test independent, and the nondeterminism that makes a suite
untrustworthy.

**What it does not authorize:** a test count is not confidence. A suite that is
green but hollow is weaker than a small suite that can fail. And the number of
tests never justifies calling a behaviour verified.

## TypeScript

**Source:** the TypeScript Handbook, Josh Goldberg's *Effective TypeScript*,
and Richard Johnson's *TypeScript in Practice*.

**Question it produces:** does the type actually say what the value is? A
value of an unknown shape is not a value of a guessed shape, so the unknown
type forces a decision where the permissive type invents one. Narrowing is how
the compiler proves the type, and a narrowing that depends on an unchecked
assumption is not narrowing. A discriminated union puts the variation where the
compiler can see it, so an unhandled case becomes a compile error rather than a
runtime surprise. The boundary matters most: a type annotation validates
nothing that arrives from outside the program, so data crossing that boundary
is checked at runtime or not at all.

**What it does not authorize:** the installed version decides how the compiler
behaves, so a claim about what the type system accepts or rejects is only true
for a named version. And a type error is never by itself a user-facing defect.

## UX and interaction

**Source:** Don Norman, *The Design of Everyday Things*; Jakob Nielsen's
usability heuristics; Alan Cooper, *About Face*; Steve Krug, *Don't Make Me
Think*.

**Question it produces:** can a person tell what is available, what will
happen, and what just happened? Signifiers show where the action is. Mapping
connects a control to its effect. Feedback confirms the effect. A mental model
lets a person predict the system without reading it. The gulf of execution is
the gap between the intention and the action, and the gulf of evaluation is the
gap between the action and the understanding of the result. The heuristics are a
checklist for state visibility, error prevention, recognition over recall and
recovery. Krug adds the scan: is the primary action findable in the first
screenshot, and does the navigation say where the user is.

**What it does not authorize:** a heuristic is a heuristic, not a law. It is
evidence of a question, and the question needs a real user, a real flow and a
real consequence before it becomes a finding. Never invent a persona or a study
to support it.

## Design systems and content

**Source:** Alla Kholmatova, *Design Systems*; Heydon Pickering, *Inclusive
Components*; Adam Silver, *Form Design Patterns*; Torrey Podmajersky,
*Strategic Writing for UX*.

**Question it produces:** is the vocabulary shared, and who owns the pattern?
A design system is a shared language plus a pattern library, and it evolves
under control rather than by accretion. Each pattern has an owner, and the
evolution of a pattern is a deliberate decision rather than a series of local
additions. Semantic primitives carry their own keyboard and assistive
behaviour. A form has labels, a cost for the user, validation, errors and
grouping, and the wording of an error is part of the design. The words in an
interface are action language, and they state consequences, name states and
point at recovery.

**What it does not authorize:** a design system that is missing a pattern is
not a defect, and coexistence of a new and a legacy pattern is not a defect
either. Evidence from the product beats the taste of the reviewer.

## Security and API design

**Source:** the STRIDE categorisation as a search heuristic; OWASP, NIST and
OpenSSF guidance at the current version; the Common Weakness Enumeration; John
Geewax, *API Design Patterns*; Olaf Zimmermann and colleagues, *Patterns for
API Design*.

**Question it produces:** where is the trust boundary, and what crosses it?
The actor, the capability, the entry point, the control and the consequence.
For an interface: is the operation predictable, is a repeated request safe,
does the response page, and does a new version break the existing clients? The
pattern sources also cover the long-running operation and the resource
revision.

**What it does not authorize:** STRIDE is a way to search for threats, not a
method that produces a result on its own. A category filled in is not a
finding. The finding needs the reachable path and the consequence. And the
guidance must be the current version, because a security control that changed
last year is not the control the repository has.

## Doctrine conflicts

Two durable sources can disagree, and the disagreement is not a defect in either
one. Small functions against deep modules. DRY against premature abstraction.
Isolated mocks against integration realism. Uniform consistency against a
design specific to this context.

Resolve the conflict on the local forces, in this order:

- what the evidence in this repository shows
- how often the code changes
- the cognitive load the choice puts on the next reader
- the risk of failure
- the consequence for the user
- the operational cost
- how reversible the decision is

Never choose an author by prestige. The question is not which book is right
but what this repository, at this size, with this change rate, actually
supports.

## Where the repository already does this

Three skills in this repository already hold to the rules above, and the review
composes with them rather than repeating them.

- `named-persona-adversarial-review` grounds each persona in a documented
  source, cites the principle rather than a fabricated quote, drops a persona
  it cannot ground, and holds that the persona is a lens while the finding
  stands on its own technical merit. That is the discipline this file
  describes, already implemented.
- `heuristic-evaluation` treats the heuristics as heuristics and reports
  expert judgment as expert judgment, not as evidence that a user will succeed.
  It inspects real states of a real flow instead of reasoning about the flow.
- `adversarial-reviewer` separates severity from confidence, so a severe
  finding with an unproven mechanism is not the same as a proven one, and both
  carry their evidence.

The three live under
`library/engineering/engineering-skills/skills/` and
`library/product/product-team/skills/`. A review that loads one of them
inherits the discipline, and a review that loads none of them still owes it.
