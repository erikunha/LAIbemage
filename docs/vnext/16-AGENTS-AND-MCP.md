# Agent runtime, MCP, approvals and agent evaluation

## Agent objectives

A dataset investigator can explain low-performing classes, audit data errors, compare model runs, propose experiments and assemble evidence-linked recommendations. The agent is not a free-form shell operator, storage administrator or autonomous promotion authority.

## Orchestration

Start with **one LangGraph stateful investigator** and typed tools. Parallelism only for independent read/analyze operations, bounded by budget and rate limiter. Add multiagent specialist subgraphs only after A/B evaluations demonstrate higher task success or less human work for acceptable incremental cost. No decorative swarm.

### Graph state

`run_id`, `session_id`, `dataset_snapshot_id`, `goal`, `plan`, `evidence_refs`, `tool_invocations`, `budget_remaining`, `approvals`, `errors`, `candidate_decisions`, `final_report`, `checkpoint_version`. Long-term memory stores reviewed findings scoped to dataset/ontology/model version; stale facts are invalidated on version change.

### Suggested tools and permissions

| Tool | Effect | Permission |
|---|---|---|
| `inspect_dataset` | read snapshot | read |
| `list_models` | read registry | read |
| `get_evaluation` | read metrics | read |
| `search_images` | read bounded sample index | read |
| `audit_data` | create report artifact | analyze, budget |
| `compare_models` | create comparison artifact | analyze, budget |
| `propose_review_batch` | create proposal | propose |
| `run_evaluation` | compute bounded job | approval when paid/large |
| `train_candidate` | compute and write weights | explicit approval |
| `export_dataset` | writes/export private data | explicit approval |
| `promote_model` | changes deployment | explicit privileged approval |

MCP tools wrap the **same domain operations**, not SQL or arbitrary Python invocation. Tool descriptors include JSON Schema, estimated effects, permission tier, model/hardware requirements, cost envelope and output types. Follow current MCP spec 2026-07-28 where compatible, with clear client negotiation rather than assuming all older clients support features.

## Safety and threat model

- Uploaded images, OCR, EXIF, filenames, external text, user-supplied prompts and model output are **untrusted content**, not policies.
- No tool may read a path merely because it appears in prompt text; assets resolved through scoped IDs and allowlisted roots.
- Deny arbitrary code, `shell`, unbounded web crawl, external uploads, hidden tool registration or unauthorized publication.
- Every side effect requires a declared effect class and a policy check *outside* the LLM. A prompt saying "approved" does not grant permission.
- Agent has max tool calls, latency, provider USD ceiling, token ceiling, loop detection, cancellation and error handling; trace and store write only redacted outputs.
- Review the prompt injection threat surface of model cards, dataset manifests and downloaded dependencies. No untrusted pickle models.

## Evaluation program

Task suites: correct tool choices, grounded citation accuracy, unnecessary tool calls, plan recovery, budget violations, false promotions, injection resistance, interruption/resume, multi-turn memory stale facts. Compare: deterministic program baseline, single agent, specialist subgraph. A new multiagent system does not ship because it 'looks smarter'; it ships only with measured improvement and acceptable failure/cost trade-offs.

## Human approval flow

Agent proposes action and expected effects -> server validates current object versions -> UI presents cost, data scope and diff -> human signs explicit approval token with TTL and exact scope -> executor rechecks before effect -> audit result. Approval is single-use; if artifacts or model version change, approval becomes stale and cannot be replayed.
