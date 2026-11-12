# API, local-first deployment and authenticated access

## Existing state

`apps/api` is currently a placeholder. Do not treat the generated OpenAPI seed as an implemented HTTP service. Build API incrementally around existing TS application services, with Fastify typed routes and Zod-derived request/response validation.

## Local mode

`vision-lens studio` starts or discovers a loopback-only API and the Python worker. Bind to `127.0.0.1`, require a randomly generated session token if the browser is exposed, and protect write endpoints against CSRF/CORS and DNS rebinding. No unauthenticated port on `0.0.0.0` by default. For shared/public demos use a separate hardened deployment profile with restricted accounts and quota.

## API rules

- `/health/live` (no downstream dependency), `/health/ready` (store and worker), `/v1/capabilities` (runtime, CPU/MPS/GPU, model extras), `/v1/jobs`, `/v1/datasets`, `/v1/annotations`, `/v1/evaluations`, `/v1/models`, `/v1/agents`.
- Request/response schemas generated from `@vision-lens/contracts`; custom API envelopes typed. Signed, expiring artifact URLs for large results; no raw filesystem path in browser contract.
- `POST` with `Idempotency-Key` on job creation; bearer token in Authorization header for remote authenticated use; error model with code, message, retryable, correlation ID. Avoid revealing resource existence across scopes.
- SSE for job events with `Last-Event-ID`; event IDs stable; no embedding of large/secret payloads in SSE.
- Model rate limit and cost gate independent of frontend; worker cannot bypass approval via calling internal endpoints.
- OpenAPI snapshot must be a generated artifact, with drift gate and generated light TypeScript client; do not hand-maintain duplicate endpoint schemas.

## Deployment stages

| Profile | Components | Constraints |
|---|---|---|
| Local single-user | SQLite, content-addressed disk, local Python workers, optional VLM APIs | loopback only, CPU/MPS |
| Portfolio hosted demo | static/hosted Studio + restricted API, prerecorded artifacts; optional request-limited worker | no arbitrary upload/execution, rate and spending cap |
| Self-hosted team | authenticated Fastify API, object storage, Postgres adapter if approved | migration, backup, auth, observability |
| GPU worker | optional remote worker with auth and network isolation | model pinning, hardware telemetry |

Use Docker Compose only when it reduces setup complexity; the main Mac MPS local path should not require a CUDA container. No Kubernetes until real scheduling/scale data justify it.

## Data protection

EXIF GPS/device IDs stripped in publicly shown assets, allowlist model artifact sources, image uploads size/dimension/cost bounded, short-lived secrets, no open proxy to third-party model APIs, CORS allowlist, CSP and secure cookies where appropriate. Public demo only synthetic/permitted datasets with documented licenses.
