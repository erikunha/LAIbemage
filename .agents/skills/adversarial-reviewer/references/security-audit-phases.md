## Security Audit Method

Method source: Cloudflare's security-audit-skill (MIT).

This method defines a six-phase security audit that an agent runs on a diff or a repository. It applies to security-sensitive changes such as authentication, cryptography, input parsing, deserialization, file paths, shell execution, and network interactions.

### Phase 1: Reconnaissance

Map entry points, trust boundaries, and data flows across the target change:
1. List all external entry points (HTTP handlers, RPC endpoints, CLI arguments, environment variables, message queues, file inputs).
2. Identify trust boundaries crossed by data moving from external or untrusted sources into internal subsystems.
3. Trace data flows from entry points to internal operations, noting transformations, decoders, and validation steps.

### Phase 2: Coverage-Led Hunting

Systematically walk each trust boundary rather than inspecting only suspicious files:
1. Enumerate every identified trust boundary systematically.
2. Inspect all handling logic along each boundary path, including utility functions, shared helpers, and serialization layers.
3. Do not limit review to visibly complex or modified files; follow the complete path where untrusted data travels.

### Phase 3: Candidate Validation

Validate every potential vulnerability with a concrete input:
1. Each candidate finding requires a specific, reproducible input that reaches the target sink.
2. If no concrete input can reach the sink, discard the candidate.
3. The rule is absolute: no input, no finding.

### Phase 4: Findings Ledger

Maintain an audit ledger during review with one row per candidate:

| Location | Input | Sink | Status | Evidence |
|----------|-------|------|--------|----------|
| `file:line` | Concrete input payload or parameter | Dangerous operation or sink | confirmed / rejected | Exact code path or rationale for rejection |

Record every candidate explored, including rejected candidates and the reason the sink was unreachable.

### Phase 5: Adversarial Verification

Run a distinct second pass to disprove each confirmed finding:
1. Adopt the perspective of a defender arguing why the code is safe.
2. Inspect sanitizers, type constraints, framework protections, deployment guards, and upstream preconditions.
3. If the second pass demonstrates that the input cannot trigger the sink or is neutralised before reaching it, change the candidate status to rejected.

### Phase 6: Report

Construct the final audit report containing only confirmed findings:
1. Include only findings that survived adversarial verification with status confirmed.
2. Provide the concrete reproducing input for each confirmed finding.
3. Present the location (`file:line`), the reached sink, and the confirmed exploit or failure path.
