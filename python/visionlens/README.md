# visionlens

A local-first visual AI runtime for Python, fully simulated in this release.
It ships the deterministic simulated encoder, the model registry and a JSONL
worker speaking the frozen `visionlens.worker.v1` protocol. The standard
library is the only runtime dependency: no numpy, no torch, no network, and
no Node.js anywhere.

The frozen wire statements this package implements live in the tracked pack
under `docs/vnext/contracts/proposed/worker-request.v1.schema.json` and
`docs/vnext/contracts/proposed/worker-event.v1.schema.json`. Where a decision
was not fixed by a schema (who says hello first, the frame limit, the error
mapping), this package follows the frozen wire format brief and pins the
choice in code and tests.

## Install

```sh
uv build                 # produces dist/*.whl and dist/*.tar.gz
pip install visionlens   # once published; today install from the wheel
```

Extras (`vision`, `training`, `agents`, `server`, `all`) exist with frozen
names and empty dependency sets while the whole runtime is simulated. A
registry model that requires an extra (today `siglip2-large` requires
`vision`) refuses with `MISSING_EXTRA` naming the exact install command
until the extra is provided to the `Worker`.

## The worker

```sh
python -m visionlens.worker
```

The worker reads host frames from stdin and writes its frames to stdout,
one JSON object per line with exactly one trailing newline. Logs go to
stderr and only frames go to stdout. On start it emits an unprompted
`hello` frame:

```json
{"protocol":"visionlens.worker.v1","kind":"hello","protocolVersion":"1.0.0","contractVersion":"1.0.0","supportedOperations":["vision.embed","vision.predict","dataset.audit","eval.run","model.train"],"capabilities":{"device":"cpu","extras":[],"models":["clip-vit-b32","dinov2-small","siglip2-base","siglip2-large"]},"maxFrameBytes":1048576}
```

The host answers with its own `hello` (fields `protocol`, `kind`,
`protocolVersion`, `contractVersion`, optional `maxFrameBytes`). Until that
hello arrives, every request is refused with `UNSUPPORTED_PROTOCOL`. A
handshake hello whose protocol or contract major differs is refused the same
way; a frame carrying any other protocol string is refused with
`PROTOCOL_MISMATCH`.

The five frozen operations are served with deterministic simulated results:

| Operation | params | result fields |
|---|---|---|
| `vision.embed` | `{images, model, device?}` | `model, dimension, dtype, count, vectors, artifactSha256, preprocessingFingerprint, device` |
| `vision.predict` | `{images, model}` | `model, predictions, artifactSha256` |
| `dataset.audit` | `{root}` | `samples, duplicates, missingHashes, classCounts, licenseGaps` |
| `eval.run` | `{split, predictions}` | `macroF1, perClass, balancedAccuracy, ece, support` |
| `model.train` | `{dataset, recipe}` | `modelId, artifactSha256, metrics` |

Rules the worker enforces on every session:

- `seq` is strictly increasing per `requestId` and starts at 0; exactly one
  `result` or `error` frame terminates each dispatched request; a cancelled
  request ends with `CANCELLED` and never emits a result.
- `cancel` by `requestId` stops an in-flight request at its next checkpoint.
  A cancel after the result, or for an unknown id, is recorded as a no-op.
  SIGTERM and SIGINT cancel in-flight requests and exit cleanly.
- `budget.maxSeconds` is a hard deadline answered with `DEADLINE_EXCEEDED`;
  the simulated token cost of a recipe answered with `BUDGET_EXCEEDED` when
  it exceeds `budget.maxTokens`.
- Frames are limited to 1 MiB by default, negotiable through `maxFrameBytes`
  in the host hello. An oversized line is refused without buffering it
  whole.
- A line that is not a frame gets one `MALFORMED_FRAME` error and the worker
  keeps serving.

The frozen error vocabulary (`UNSUPPORTED_PROTOCOL`, `MISSING_EXTRA`,
`MALFORMED_FRAME`, `PROTOCOL_MISMATCH`, `UNSUPPORTED_OPERATION`,
`CANCELLED`, `DEADLINE_EXCEEDED`, `BUDGET_EXCEEDED`, `WORKER_CRASHED`,
`PROVIDER_UNAVAILABLE`) with its retryable flags lives in
`visionlens.errors`. The simulated path never emits `PROVIDER_UNAVAILABLE`;
it is reserved for the real provider seam (`PROVIDER_BASE_URL`).

## Library surface

```python
from visionlens import (
    ErrorCode, ModelRegistry, ModelSpec, UnknownModelError,
    Worker, WorkerError, embed_bytes, preprocessing_fingerprint,
)

registry = ModelRegistry.default()
spec = registry.resolve("siglip2-base")   # UnknownModelError for anything else
vector = embed_bytes(b"image-bytes", spec)  # deterministic, depends on the bytes
fingerprint = preprocessing_fingerprint(spec)  # fp2: form
```

The encoder is deterministic by construction: the same bytes plus the same
model always give the same vector, the vector depends on the bytes, and the
derivation reads the `ModelSpec` (revision, dimension), so the real encoder
replaces `embed_bytes` without touching the protocol.

## Golden transcript

`visionlens/golden/session.jsonl` records a scripted session (handshake,
one malformed-line error case, one embed to its result). Regeneration must
be byte identical:

```sh
python -m visionlens.golden --check   # exit 1 on drift
python -m visionlens.golden --regen   # rewrite after an intended change
python -m visionlens.golden --print   # dump the transcript
```

## Development

```sh
cd python/visionlens
python3 -m pytest tests -q
uv build
```

Python 3.11 or newer is required; the package uses no syntax newer than
3.11 and ships a `py.typed` marker.
