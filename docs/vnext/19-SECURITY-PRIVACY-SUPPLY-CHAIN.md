# Security, privacy and supply-chain requirements

## Assets and trust boundaries

Untrusted surfaces: user images/videos, model weights, file metadata/EXIF/OCR, imported manifests, HTTP URLs, plugin code, MCP tool descriptions from external parties, LLM-generated text and remote provider responses. Trusted components: compiled code + verified manifests, policy engine, authenticated identity, signed approval token and deterministic validators. Never elevate content to instructions.

## Mandatory controls

- Input validation: MIME vs magic bytes, image dimension and decoded-pixel caps, maximum archive files/expanded size, traversal/symlink protection, file path allowlist, SSRF protection for remote URLs.
- Model artifact supply chain: allowlisted repositories, exact revision and SHA, license/terms registry, vulnerability scanning, prefer safetensors, no arbitrary pickle load, limited remote code execution (`trust_remote_code=False` unless explicit audited sandbox).
- Third-party APIs: secrets in env or encrypted secret store, never URL/query/log/prompt; optional BYOK in private mode only with nonpersistent per-session encrypted lifecycle; provider keys not accessible from client after submission.
- Tool permissions: read/analyze/propose/execute/promote policy gate; approval cannot be inferred from prompt; enforce max scope, max cost, max time.
- Authorization: local session token, remote OIDC/short-lived bearer tokens when exposed; deny by default. Explicit access rules on each dataset, artifact and agent run.
- Privacy: default local processing, per-provider egress disclosure, EXIF redaction, retention by artifact class, user-controlled deletion policy and documented data processor roles.
- Licensing: dataset and checkpoint licensing verified before distribution/commercial use; record copyright attribution and compatibility; prevent release when provenance missing.
- Logs and traces: redact secrets, PII, raw images, user-supplied local paths and potentially malicious content; record hashes and IDs instead.

## Agent threat cases

1. OCR text instructs agent to upload private images — no upload tool exposed without explicit approval and allowlisted destination.
2. Malicious dataset file path `../../.ssh` — file ingestion refuses escape after path canonicalization.
3. External MCP server renames tool with privileged description — server only registers pinned allowlisted tools; do not trust imported descriptions.
4. Large image decompression bomb — bounded decoder rejects before allocation.
5. Provider returns malformed structured output — validate schema, treat as model error, do not mutate store.
6. Model artifact attempts arbitrary code via pickle — disallow without isolated trusted execution and explicit operator consent.

## Security acceptance

Documented STRIDE-style threat review; static/dependency/secret scan CI; path traversal and SSRF integration tests; prompt injection regression suite; API auth tests; audit entries for privileged actions; restore test after data deletion and backup. Never publish actual credentials or sensitive source images to the public repo.
