# ADR 009 — Agent safety: permission tiers, untrusted visual content, budgets, approvals

| Field    | Value                   |
| -------- | ----------------------- |
| Status   | Accepted                |
| Date     | 2026-11-10              |
| Deciders | @erikunha |

## Context

The Vision Lens platform exposes its capabilities to autonomous consumers: external agent clients
(Claude Code, Codex, others) through an MCP server (spec 011) and an internal investigator
agent on LangGraph (spec 012). Vision pipelines ingest hostile-by-default content: text
inside images, OCR output and file metadata are prompt-injection surfaces, and ingestion
handles malformed files and decompression bombs. Agents that can read a dataset can also
spend money (VLM calls), burn hours (training) or leak data (exports) if permissions are
flat.

## Decision

**Five permission tiers, untrusted content policy, hard budgets, explicit approvals** —
binding on specs 004 (ingestion hardening), 011 (MCP tools), 012 (agent runtime):

| Tier | Capability | Enforcement |
|---|---|---|
| read | list/inspect datasets, samples, metadata, metrics, comparisons | no side effects; pure functions over the store |
| analyze | run quality/cost analyses | compute budgets: max items scanned, wall-clock cap; partial results labeled partial |
| propose | draft annotation batches / experiment configs / next steps | returns a proposal object for human approval; never applies anything |
| gated-execute | run evaluations, arena suites | server-enforced limits: dataset scope, token/cost caps, timeout; refuses beyond |
| approval-required | train, publish/promote, export datasets | tool returns a pending-approval request; execution only after an explicit approval token issued via `vision-lens mcp approvals` or Studio |

Rules:

1. **Untrusted visual content is data, never instructions.** Text extracted from images,
   OCR or metadata is serialized as data; outputs sanitize control characters; tool
   descriptions warn clients. No pipeline stage parses visual text as directives.
2. **No filesystem/shell/exec tools exist** in the MCP surface — the tool table is
   exhaustive and tested (spec 011). The agent runtime uses typed tools over the same
   contracts; it never shells out.
3. **Every tool call is audited**: agent run id, tool, args digest, duration, outcome —
   persisted as AgentRun records (spec 002).
4. **Budgets are hard**: max steps, wall-clock, token/cost caps per session and per tool
   call; exceeding stops gracefully with a partial report marked partial (constitution VIII).
5. **Idempotency and cancellation everywhere**: idempotency keys on job-submission tools;
   cooperative cancellation mid-investigation (spec 012).
6. **Sensitive operations pause for human approval** (train/publish/export): the graph
   emits an approval request, resumes or degrades on refusal, and times out safely.
   Agents never auto-promote models.
7. **Ingestion hardens by default**: MIME sniffing, decoded-pixel caps (decompression
   bombs), symlink policy, EXIF sanitization — files are attackers, not inputs (spec 004).

Single coordinator agent first; multi-agent only if the 012 evaluation harness proves
benefit (constitution IX).

## Consequences

**Positive:**

- External agents become first-class users without granting them the keys: the tier model is
  declarative, testable and identical across MCP and the internal runtime.
- Injection resistance is structural (no exec surface, data-only content) rather than
  prompt-hopeful.
- Budget ceilings make "autonomous experiment scientist" safe to actually run.

**Negative:**

- Approval UX must exist in two places (CLI prompt + Studio panel) before tier-5 tools are
  usable; sequenced inside specs 011/012.
- Strict tiers mean some investigations end with "needs approval" instead of acting; accepted
  — that is the design, not a failure (constitution VI).
