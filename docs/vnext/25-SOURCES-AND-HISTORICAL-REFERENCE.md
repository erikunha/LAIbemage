# Evidence sources and legacy design references

## Primary inspected repository resources

- GitHub repository: https://github.com/erikunha/LAIbemage
- Branch: https://github.com/erikunha/LAIbemage/tree/feat/visual-lens
- Current roadmap: `ROADMAP.md` on that branch.
- Current ADRs: `docs/adr/005-vision-lens-pivot.md`, `006-monorepo-ts-python.md`, `007-local-first-infra.md`, `008-evidence-policy.md`, `009-agent-safety-tiers.md`, `010-spec-kit-untracked.md`.
- Existing contracts: `packages/contracts/src/` and `packages/contracts/openapi.snapshot.json`.
- Existing domain persistence: `packages/core/src/store/`, migrations and importer.
- Existing benchmarks: `docs/architecture/benchmark.md`, `docs/datasets/visa.md`, `benchmarks/splits/visa-subset.gold.json`, `benchmarks/predictions/visa-subset.gpt-4o.json`, `benchmarks/baselines/visa-subset.json`.
- Public test baseline claims are authored in those files, not re-executed in this packet.
- Prior blueprint: `reference/LAIbemage_Master_2026-11-10.zip`. Historical source only. If a decision conflicts, this vNext package and later accepted repository ADRs take precedence.

## Official external documentation (verify versions during implementation)

- uv workspaces: https://docs.astral.sh/uv/concepts/projects/workspaces/
- uv packaging/publishing: https://docs.astral.sh/uv/guides/package/
- PyTorch MPS: https://docs.pytorch.org/docs/stable/notes/mps.html
- Pydantic JSON Schema: https://docs.pydantic.dev/latest/concepts/json_schema/
- Fastify JSON Schema validation: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- OpenAPI Specification: https://spec.openapis.org/oas/latest.html
- ONNX Runtime: https://onnxruntime.ai/docs/
- MLflow: https://mlflow.org/docs/latest/
- Hugging Face model security: https://huggingface.co/docs/hub/security-pickle
- MCP specification: https://modelcontextprotocol.io/specification/2026-07-28
- VisA dataset registry: https://registry.opendata.aws/visa/
- COCO: https://cocodataset.org/
- Ultralytics classification dataset formatting: https://docs.ultralytics.com/datasets/classify/

## Evidence quality labels

**Observed** = inspected code/docs on public branch. **Repo-documented** = claim made by repository with artifacts, not re-executed here. **Proposed** = vNext design/implementation. **Measured** = only when an execution report with commands/hardware/artifact hash was actually produced. These labels belong in portfolio material and release reports.
