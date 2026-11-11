# Developer experience, distribution and publishing strategy

## End-user journeys

**Python researcher:** `pip install visionlens[vision]` (once published) -> local import with example images -> run embedding/classification -> inspect evaluation JSON; no Node service needed.

**Node developer:** `npm install @vision-lens/sdk` (once published) -> typed API client points at managed/local API -> start job -> SSE updates -> result. No Python process required in npm consumer machine when connecting remotely.

**CLI user:** `vision-lens doctor` -> local model capability report -> import images -> evaluate -> optional `--json` output for scripts. Legacy `ai-image-labeling` stays documented during deprecation.

**Applied AI user:** `vision-lens mcp serve` -> guarded read/analyze/propose tools -> bounded investigation with references -> approval for expensive/privileged actions.

## Publishing readiness

1. Verify PyPI project name, npm scope ownership and trademark availability; until then package names tentative, not claims.
2. Python `uv build`, check wheel and sdist contents, `twine check` or equivalent metadata validator, clean venv install, `py.typed` included, import with minimal extras.
3. npm `pnpm pack` + clean Node test for ESM/types/browser; no secret/symlink/site-dependency leaks.
4. Generate API docs from Zod/OpenAPI, Python docstrings and typed SDK. Publish model/dataset cards, screenshots, tutorial and changelog.
5. Publish via CI trusted identity/OIDC with tag confirmation and provenance, independent semver for Python/TS when APIs decouple; schema compatibility matrix maintained.
6. Release automation requires manual approval for first public release and high-impact major upgrades.

## Semver examples

- Python `0.x`: pre-stable, document breaking changes, release notes and migration.
- TS `@vision-lens/contracts` existing version `1.0.0`: breaking changes require major increment and migration path.
- HTTP `/v1`: separate wire version; not equivalent to npm package major, explicitly documented.
- Bridge `visionlens.worker.v1`: independent protocol major; handshake rejects mismatch.

## Portfolio presentation

Landing README with 60-second GIF or short mp4 (original demo), reproducible demo link, benchmark table with limitations, architecture diagram, readme "How it works", "What failed", CLI+Python+SDK examples and decisions. Highlight tradeoffs: real vs synthetic data, calibrated vs raw confidence, cost-of-error, local-first and safe agent operations. No invented performance claims.
