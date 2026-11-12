# visionlens

A local-first visual AI runtime for Python, fully simulated in this release.
It ships the deterministic simulated encoder, the model registry and a JSONL
worker speaking the frozen `visionlens.worker.v1` protocol. The standard
library is the only runtime dependency: no numpy, no torch, no network, and
no Node.js anywhere.

> **Proposed API.** The operation names and object types on this package's
> public surface are proposed, not frozen: ADR-011 is accepted as built
> (`docs/adr/011-python-first-ml-runtime.md`), and the pack keeps the names
> tentative until the remaining acceptance conditions land
> (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:56`). Names may change before 1.0.
> The frozen exception is the `visionlens.worker.v1` wire vocabulary, which
> changes only by a major version refusal.

The frozen wire statements this package implements live in the tracked pack
under `docs/vnext/contracts/proposed/worker-request.v1.schema.json` and
`docs/vnext/contracts/proposed/worker-event.v1.schema.json`. Where a decision
was not fixed by a schema (who says hello first, the frame limit, the error
mapping), this package follows the frozen wire format brief and pins the
choice in code and tests.

## Install

The package is **not published to PyPI**. Until the release gate is green
and a publication is approved, install from a locally built artifact:

```sh
cd python/visionlens
uv build                       # produces dist/visionlens-0.1.0-py3-none-any.whl and the sdist
pip install dist/visionlens-0.1.0-py3-none-any.whl
```

`pip install visionlens` works only once the package is published; no such
claim is made today.

## Extras

One distribution, heavy capabilities only through extras. The extra names
are frozen; the dependency sets stay empty while the whole runtime is
simulated, so every extra installs the same light base today.

| Extra | Installs | Status |
|---|---|---|
| (base) | nothing beyond the standard library | shipped |
| `vision` | the encoder and model adapter stack (empty set today) | name frozen, set empty |
| `training` | the training recipe and experiment tracking stack (empty set today) | name frozen, set empty |
| `agents` | the agent runtime import boundary (empty set today) | name frozen, set empty |
| `server` | the HTTP surface stack (empty set today) | name frozen, set empty |
| `all` | the aggregate of the above (empty set today) | name frozen, set empty |

The canonical spelling is `training`; `train` is treated as an abbreviation,
not a second extra. A registry model that requires an extra (today
`siglip2-large` requires `vision`) refuses with `MISSING_EXTRA` naming the
exact install command until the extra is provided to the `Worker`.

## Library surface

```python
from visionlens import (
    ErrorCode, ModelRegistry, ModelSpec, UnknownModelError,
    Worker, WorkerError, authorize_download, embed_bytes,
    preprocessing_fingerprint,
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

No artifact is ever fetched implicitly. `authorize_download` is the opt-in
boundary: without explicit permission plus a recorded provenance (source,
exact revision, license, sha256 digest) it raises a typed
`DownloadRefusedError` instead of reaching for the network.

```python
from visionlens import DownloadProvenance, authorize_download

provenance = DownloadProvenance(
    source="https://huggingface.co/google/siglip2-base-patch16-224",
    revision="r2026-03-01",
    license="apache-2.0",
    sha256="0" * 64,
)
authorized = authorize_download(
    "model", "siglip2-base", permitted=True, provenance=provenance
)
```

### Proposed facade (not shipped)

The typed facade `VisionLens.local(LocalConfig(...))` with
`.capabilities()`, `.datasets.inspect(path)` and `close()` is **proposed and
not implemented** in this release. It is tracked as spec 017 user story 3;
landing it involves a base-install dependency decision that is recorded in
ADR-011's packaging rules, so it ships only together with that decision.

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

## Golden transcript

`visionlens/golden/session.jsonl` records a scripted session (handshake,
one malformed-line error case, one embed to its result). Regeneration must
be byte identical:

```sh
python -m visionlens.golden --check   # exit 1 on drift
python -m visionlens.golden --regen   # rewrite after an intended change
python -m visionlens.golden --print   # dump the transcript
```

## Release gate and publishing policy

Nothing is published today. The gate
(`python/visionlens/scripts/release_gate.py`, run as
`python3 python/visionlens/scripts/release_gate.py`) builds the artifacts,
validates their metadata, installs the wheel and the sdist into clean venvs
with node removed from `PATH`, scans both artifacts for checkpoints,
datasets, credentials and build-machine paths, resolves every extra, checks
the lock against the published ranges, runs the dependency scan, and reads
the dated records under `python/visionlens/release/`. Its evidence lands in
`release/gate/run-*.json`. The gate must be green before any document says
the package is publicly installable.

Publication, when it is approved, will run only from a signed and tagged
release, with CI trusted identity and tag confirmation, with build
provenance recorded, and with manual approval for the first public release
(`docs/vnext/22-PUBLISHING-DEVELOPER-EXPERIENCE.md:19-20`). This is policy
only: no workflow, credential or publish step for it exists.

## Development

```sh
cd python/visionlens
python3 -m pytest tests -q    # package tests
uv lock                       # refresh the development lock (exact pins, exclude-newer cutoff)
uv run --group dev mypy src/visionlens   # type check, zero errors
uv build                      # build the wheel and the sdist
python3 scripts/release_gate.py          # the release gate
```

Python 3.11 or newer is required; the package uses no syntax newer than
3.11 and ships a `py.typed` marker.
