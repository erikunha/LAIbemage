# visionlens

A local-first visual AI runtime for Python. It ships the deterministic
simulated encoder, the model registries, the CPU vision adapter (the decoder,
the canonical preprocessing, the SigLIP2 encoder and the content-addressed
artifact), a JSONL worker speaking the frozen `visionlens.worker.v1` protocol
and the typed public facade.

The base install carries Pydantic for the typed configuration and Pillow for
the image decoder, and nothing else: no numpy, no torch, no network, and no
Node.js anywhere. The encoder stack that reads a real checkpoint lives behind
the `vision` extra, so the base install never pulls a PyTorch or a
Transformers download.

> **Proposed API.** The operation names and object types on this package's
> public surface are proposed, not frozen: ADR-011 is accepted as built
> (`docs/adr/011-python-first-ml-runtime.md`), with a dated amendment to its
> packaging rules for the base install, and the pack keeps the names
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
are frozen. The base install carries Pydantic for the typed configuration
and Pillow for the image decoder, and nothing else, so it never pulls a
PyTorch or a Transformers download, and every heavy stack lives behind the
extra that needs it.

| Extra | Installs | Status |
|---|---|---|
| (base) | Pydantic for the typed configuration and records, Pillow for the image decoder | shipped |
| `vision` | torch, transformers and safetensors: the encoder stack that reads a real checkpoint | shipped |
| `training` | the training recipe and experiment tracking stack (empty set today) | name frozen, set empty |
| `agents` | the agent runtime import boundary (empty set today) | name frozen, set empty |
| `server` | the HTTP surface stack (empty set today) | name frozen, set empty |
| `all` | the aggregate: it pulls `vision` | shipped |

The canonical spelling is `training`; `train` is treated as an abbreviation,
not a second extra. A registry model that requires an extra (today
`siglip2-large` requires `vision`) refuses with `MISSING_EXTRA` naming the
exact install command until the extra is provided to the `Worker`.

## Library surface

```python
from visionlens import (
    ErrorCode, ModelRegistry, ModelSpec, UnknownModelError,
    Worker, WorkerError, authorize_download, embed_bytes,
    load_model_registry, preprocessing_fingerprint, resolve_model,
)

registry = ModelRegistry.default()
spec = registry.resolve("siglip2-base")   # UnknownModelError for anything else
vector = embed_bytes(b"image-bytes", spec)  # deterministic, depends on the bytes
fingerprint = preprocessing_fingerprint(spec)  # fp2: form
```

There are TWO registries, and they are not the same thing.
`ModelRegistry` is the simulated runtime's frozen list of placeholder models,
with placeholder revisions: it is what `embed_bytes` runs on today.
`load_model_registry` reads the CAPABILITY registry, the pinned records of the
models the platform may run, from `datasets/registry.json`:

```python
# the registry file of the repository; the wheel ships no registry of its own
records = load_model_registry("datasets/registry.json")
record = resolve_model(records, "siglip2-base")  # ModelNotFoundError for anything else
record.revision, record.source_digest, record.license
```

The capability record names exact bytes, an exact revision and a license, and
it is refused when it cannot be trusted. Reading it never reaches the network:
fetching the bytes it names is a separate, explicitly permitted act.

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

### The weights loader

The loader is the only place where the bytes of a model are fetched, and it
fetches them only when every gate says yes: the use the recorded license
permits, an explicit permission, a trust policy the loader implements, an
allowlisted source at the pinned revision, a safetensors file, and a digest
that matches the record. The bytes are streamed to the cache in bounded
blocks and never held in memory.

```python
from visionlens import (
    DownloadPermission, WeightsRequest, authorize_weights_download, load_weights,
)

request = WeightsRequest(
    record=record,
    use="inference",
    permission=DownloadPermission.grant("the operator"),
)
authorized = authorize_weights_download(request)  # DownloadRefusedError, or the proof
loaded = load_weights(request, Path("~/.cache/visionlens/weights").expanduser())
print(loaded.path, loaded.digest == record.source_digest)
```

Without the permission nothing is fetched and the cache directory stays
empty. The cached file is named after the digest of its bytes, so it can be
verified again without the network.

### The CPU embedding run

The adapter decodes an image, preprocesses it with the canonical spec,
embeds it on the CPU and writes the vectors into a content-addressed
artifact: a binary vectors file beside a manifest that carries every
field of FR-011. The vectors never travel inside a JSON line.

```python
from visionlens import (
    DecodeService, DevicePlanner, EmbedAsset, EmbedRequest, VisionEmbedder,
)

plan = DevicePlanner().plan("cpu")
embedder = VisionEmbedder(
    record=record,
    encoder=encoder,          # the SigLIP2 adapter
    spec=spec,                # the canonical preprocessing
    decoder=DecodeService("datasets/images"),
    device=plan,
    artifact_root=Path("~/.cache/visionlens/artifacts").expanduser(),
)
result = embedder.embed(
    EmbedRequest(snapshot_id="snapshot-1", assets=(EmbedAsset(asset_id="a.jpg", path=Path("datasets/images/a.jpg")),))
)
print(result.run_id, result.dimension, result.dtype, result.count)
print(result.artifact_sha256)   # the vectors are on disk, not in the frame
```

An image that cannot be decoded is an error sample and not a failed run:
the error names the file and the other images still embed. A batch that
exhausts the memory budget is retried with fewer images a bounded
number of times, and the back off is an event that names the old and
the new batch size.

### The golden parity gate

One golden file, read by both languages, and a gate that compares the
config fingerprint computed by the live TypeScript implementation, the
manifest validated against the ratified schema, and every golden vector
against the artifact inside the documented tolerance.

```bash
pnpm exec tsx scripts/benchmarks/vision-parity.ts
```

The gate never writes the golden file, and a golden file whose vectors
were edited is detected. `docs/architecture/vision-adapter.md` describes
the pipeline, the refusals and the recorded run.

### The typed facade

```python
from visionlens import LocalConfig, VisionLens

with VisionLens.local(LocalConfig(device="auto")) as client:
    capabilities = client.capabilities()
    print(capabilities.device)             # "cpu"
    print(capabilities.installed_extras)   # the extras available on this machine
    print(capabilities.version)            # "0.1.0"

    inspection = client.datasets.inspect("example.png")
    print(inspection.width, inspection.height, inspection.mime_type)
    print(inspection.sha256)
```

`LocalConfig` is a versioned Pydantic model: it serializes to plain JSON
(`config.to_json()`) and round-trips (`LocalConfig.from_json(raw)`), and a
payload carrying another schema version is refused rather than interpreted.

`capabilities()` reports what this machine can actually do: the resolved
device and the reason for it, the state of every declared extra (available,
or which modules are missing), and the package version. The record is
serializable, so it can be stored next to a result.

The device comes from the device planner, and the planner holds the only
vocabulary of the platform: `auto` resolves to an admitted device and
records why it fell back, and an explicit device this build does not
admit is refused with its reason. This build admits the CPU only, so a
request for an accelerator fails instead of running somewhere else, and
the reason of the fallback names the accelerators the machine has.

`datasets.inspect(path)` reads the metadata of one image: width, height, MIME
type and the sha256 of its bytes. It needs no Node, no server and no network,
and it reads only the header: the pixels are never decoded and no image
library is required. The MIME type comes from the magic bytes, never from the
file name, and an extension that contradicts them is refused.

Every failure is typed and carries a stable code from `visionlens.errors`:
`PATH_NOT_FOUND`, `UNSUPPORTED_FILE_TYPE`, `MIME_MISMATCH`,
`IMAGE_DIMENSIONS_EXCEEDED`, `IMAGE_METADATA_UNREADABLE`, `UNSUPPORTED_DEVICE`,
`CONFIG_INVALID`, `CONFIG_VERSION_UNSUPPORTED` and `CLIENT_CLOSED`. These are
library-level codes: they never enter the frozen wire vocabulary, and their
messages carry no traceback.

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

The dependency scan runs pip-audit over the requirements exported from the
committed lock, and records every finding with its severity. pip-audit reports
the finding without one, so the severity is read from OSV, the advisory
database the identifiers pip-audit reports come from: the advisory's own label
when it carries one, and its CVSS vector scored when it does not. An
unreviewed high severity finding blocks the gate, and so does a finding no
authority could size, because an unsized finding is an unreviewed one. A
finding reviewed on purpose is listed in
`release/dependency-scan-reviewed.json`, a JSON array of objects whose `id` is
the identifier pip-audit reports for it (an alias does not match), and it no
longer blocks. A file that cannot be read blocks every finding rather than
passing any of them.

Publication, when it is approved, will run only from a signed and tagged
release, with CI trusted identity and tag confirmation, with build
provenance recorded, and with manual approval for the first public release
(`docs/vnext/22-PUBLISHING-DEVELOPER-EXPERIENCE.md:19-20`). This is policy
only: no workflow, credential or publish step for it exists.

The gate runs in CI, in `.github/workflows/python-package.yml` (added
2026-11-14; the first CI run lands with this change): the job builds the
artifacts, runs the package tests, runs the type checker and runs the release
gate on the Python floor and the next supported version, and it uploads the
gate's evidence after a failed gate too. That workflow holds no registry
credential and has no publish step, so it proves the package and publishes
nothing.

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
