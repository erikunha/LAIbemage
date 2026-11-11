# Surface semantics

These are the questions a review asks when it reaches the behaviour of a running
system. They are written so that they hold for any stack: the layers are named
by the role they play, never by the product that happens to implement them.

Every section gives one falsifiable question and what to observe. A question
that cannot come back false is not a review question.

## Contents

- State ownership
- Name the cache
- Failure is not zero
- Request trace
- Authorization chain
- Data store ownership
- Retry ownership
- Migration
- Read-back
- UI states
- Performance
- Environment drift
- Observability

## State ownership

**Question:** for every piece of state the change touches, who owns it, and can
two owners hold different values for the same fact?

Write the sheet before reading the implementation. One row per fact:

| Field | Value |
|---|---|
| Fact | What is being held |
| Canonical owner | The one place the truth lives |
| Writers | Who may change it |
| Readers | Who may observe it |
| Derived copies | What is computed from it and may lag |
| Query cache | What the client holds and when it refetches |
| URL | What the address bar encodes |
| Local storage | What survives a reload |
| Server | What the backend holds |
| Reset | How the state returns to its initial value |
| Invalidation | What tells the other representations the fact moved |

Multiple representations are legitimate. A product that keeps a list in the
server, in a query cache and in the URL has three representations on purpose.

The risk is a conflict of ownership: two owners, one fact, and no rule saying
which one wins. Find that, and the finding is the absence of a rule, not the
presence of a second copy.

## Name the cache

**Question:** which cache is stale?

"The cache is stale" is not a finding. It is a direction. Say which layer: the
server response cache, the data cache, the full route cache, the router cache,
the query cache, the remote key-value store, the database.

The layers have different lifetimes and different invalidation rules, and one
invalidation usually touches one of them. A mutation that invalidates the query
cache leaves the route cache holding the old page, and the symptom looks like
the fix did not work.

Never carry a lifecycle assumption across generations of a cache. Two query
caches of different generations are two caches, each with its own key space and
its own invalidation, and a resource present in both must be exercised in both.

## Failure is not zero

**Question:** what does the user see when the request fails?

Three states are different states, and the difference is the finding:

- an error with no usable data
- an error with usable stale data
- a genuine zero result

A fallback that renders zero or an empty list when the request failed has
collapsed an error into a zero. The user reads "you have nothing" when the
truth is "we could not ask". That is a wrong answer presented confidently, and
it is usually worse than the error it replaced.

The same distinction applies to a write that failed after the user was told it
succeeded. An empty list is not an error message, and it is not a success.

## Request trace

**Question:** what is the full path of one request, and where can it fail?

Trace it in order:

1. request
2. authentication
3. authorization
4. validation
5. handler
6. domain logic
7. data, queue or workflow
8. serialization
9. response

Each step has its own failure mode and its own owner. A defect at step 4 and a
defect at step 7 produce the same status code and completely different
consequences, so the response alone never settles the cause.

## Authorization chain

**Question:** who is allowed to perform this action, and where is that decided?

Follow the chain:

1. identity: who is the caller
2. credential: what they presented
3. verification: whether the credential is genuine
4. tenant: which workspace or account they belong to
5. permission: what they may do
6. resource: which object the action touches
7. enforcement: where the backend refuses

Enforcement in the backend is the only step that decides anything. A control
that is hidden in the interface is a display decision. A user who never sees a
button still reaches the endpoint, and the review of an authorization change
that only looked at the interface has proved nothing.

Check the tenant step explicitly. It is the one most often missing, and a
permission that ignores it authorizes the action against the wrong data.

## Data store ownership

**Question:** which store is the real one for this fact?

Identify the store before reasoning about consistency, transactions or
atomicity. A repository may have several: the primary relational database, a
read replica, a document store, a cache, a search index, a queue, a vector
store. Each holds a copy of something, and the copies disagree on purpose.

Then check the transaction boundary. A database transaction makes the database
write atomic. It does not make a network call, a queue publish, a workflow
dispatch or a webhook atomic. When a transaction encloses one of those, the
commit succeeds and the external effect may still fail, or the effect may
happen twice.

An external effect needs its own idempotency. Ask what happens when the same
operation arrives twice.

## Retry ownership

**Question:** when this operation crosses layers that retry, who retries, who
deduplicates, and where is idempotency imposed?

An operation commonly crosses several layers that each retry on their own: the
client, the transport, the service, the queue consumer, the database, the
third party. Each retry multiplies the attempts of the one above it. A call
that is retried three times by the client, twice by the service and three times
by the consumer is up to eighteen executions of one logical request.

So the questions are:

- who retries
- who deduplicates
- where the idempotency key is checked and recorded
- which result is authoritative when several attempts disagree

Retry multiplication is a real risk, not a theoretical one, and it is invisible
in the happy path.

## Migration

**Question:** what does this migration do while the old code and the new code
are both running?

The operations that matter: the forward change, its registration, the backfill,
its idempotency, the locking it takes, whether it rewrites the table, the
default it sets, the nullability it changes, the index it creates, and the
order of deployment.

With a rolling deploy, four combinations exist and all four run:

1. old code with the old schema
2. old code with the new schema
3. new code with the old schema
4. new code with the new schema

A migration that only survives one of them is a migration that breaks during
deployment, which is when nobody is watching.

The existence of a down path does not prove the rollback is safe. A rollback
that loses the data written by the new code is not a rollback. Read what the
down path does to the data, not whether it exists.

## Read-back

**Question:** after the write, what read proves the write landed?

Follow the whole path:

1. user action
2. request
3. server write
4. response
5. cache update or invalidation
6. next read
7. render

A success toast and a 2xx response are not the conclusion. They report that
the request was accepted, not that the state changed. The authoritative read
is the one that goes to the store of record: the database row, the authoritative
API, the workflow state, a refetch, a reload.

For a flow that completes eventually, check both the intermediate state and the
terminal one. A job that is still pending and a job that failed look identical
from the interface.

## UI states

**Question:** which states does this view have, and which of them were
exercised?

The inventory: initial, loading, skeleton, empty, partial, populated, pending,
success, error, retry, offline, unauthenticated, unauthorized, disabled, stale,
long content, overflow, destructive confirmation.

Classify each one the change touches on five axes:

| Axis | Meaning |
|---|---|
| required | the product needs this state |
| implemented | the code has a path for it |
| reached | a user can arrive at it |
| browser-observed | it was seen in a running product |
| result | what the user got |

A state that is implemented but never reached is dead code in the product, and
a state that is reached but never observed is unverified. Never certify a
state that was not exercised.

## Performance

**Question:** which measurement would show this being slow, and what is the
baseline?

Start with a falsifiable hypothesis. "This renders too much" is a hypothesis.
"This re-renders the list on every keystroke, and the list holds two thousand
rows" is a hypothesis with a mechanism.

The measurements that decide it: request count, the waterfall, payload size,
render count, DOM size, interaction latency, long tasks, the largest contentful
paint, the input and layout shift metrics, bundle size, memory, query count,
and the query plan.

Establish the baseline before claiming a regression or an improvement. A
comparison without a baseline is a feeling.

"Looks inefficient" is not a finding. A count, a measurement and a baseline are.

## Environment drift

**Question:** is the failure in the change, or in the environment it runs in?

Before a journey counts as a regression, check the preconditions: the seed
data, the schema state, the services that must be up, the configuration. A flow
that fails because the fixture was never created is environment drift.

Resolve the drift or classify it. Do not report a missing seed as a defect in
the branch, and do not silently repair it and then report the branch as
failing either. Both readings are wrong, and they hide each other.

## Observability

**Question:** which operational question does this telemetry answer?

Logs, correlation identifiers, workflow and job context, retry visibility,
metrics and traces. Each is worth reviewing when it answers a question someone
will actually ask during an incident: what happened, to which request, in which
order, and what state is it in now.

Telemetry is not required for its own sake. A signal nobody reads is a cost
with no return, and adding one to close a review finding is not the same as
making the system operable.
