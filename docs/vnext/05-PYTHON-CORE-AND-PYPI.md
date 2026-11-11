# Python-first ML library: package design, extras and execution

## Packaging strategy

Add **one publishable** `python/visionlens/` distribution (tentative PyPI name `visionlens`); keep existing `services/{vision,training,agents}` as thin runnable entrypoints while feature parity lands. Only later decide whether workers should remain separate packages. Do not rename the current services as a first step.

```text
python/visionlens/
  pyproject.toml
  README.md
  src/visionlens/
    __init__.py
    py.typed
    api.py                  # typed local Python facade
    config.py               # Pydantic runtime config
    errors.py               # stable typed exceptions
    io/                     # image decoding, MIME, EXIF, hashing
    data/                   # dataset manifests, validation, sampling
    encoders/               # CLIP/SigLIP/DINO adapters
    models/                 # detector/classifier/VLM adapters
    inference/              # batching, calibration, prediction
    evaluation/             # metrics, splits, reports
    training/               # linear probes, fine-tune recipes
    selection/              # uncertainty/diversity AL
    runtime/                # resource/device selection, cache
    bridge/                 # framed JSONL protocol, version handshake
    agents/                 # optional LangGraph import boundary
  tests/
```

## Dependency policy

- Python minimum **3.11** initially because the existing service skeletons use `>=3.11`; matrix 3.11/3.12/3.13 only after dependencies prove compatibility. Explicit pins in `uv.lock` for the development workspace; compatible ranges in published `pyproject`.
- Base install `pip install visionlens` should include Pydantic, limited I/O and lightweight NumPy only if core operations truly need it; **no mandatory GPU/PyTorch/Transformers/MLflow download**.
- Optional extras `vision`, `train`, `agents`, `server`, `all`. Heavy optional imports lazy and produce actionable `MissingExtraError` with `pip install visionlens[train]`.
- `uv` workspace supported; one workspace lock if dependencies compatible. If ML stacks conflict, use isolated services and per-service locks (do not force an impossible single environment).
- Wheels: pure-Python universal wheel where possible; no bundled model checkpoints; Hugging Face downloads opt-in with explicit license and SHA provenance.
- Public distribution blocked until registry availability, license audit, README and local wheel + sdist tests pass. Avoid accidental typosquatting or naming collision claims.

## Native Python API (proposed)

```python
from visionlens import VisionLens, LocalConfig

with VisionLens.local(LocalConfig(device='auto', cache_dir='./.cache')) as vl:
    dataset = vl.datasets.from_directory('./examples/inspection', ontology='ontology.json')
    embedding_run = vl.embeddings.run(dataset.id, model='siglip2-base')
    report = vl.evaluations.run(
        dataset_snapshot_id=dataset.snapshot_id,
        model_id='siglip2-base',
        suite='classification-v1', split='test'
    )
    print(report.metrics.macro_f1)
```

All operation names and object types are **proposed**. File hashes, split, model revision and device metadata always flow into the run manifest. Must support `device='cpu'` and MPS when actually supported; unsupported operations should explicitly fall back or fail with reason, never silently change method.

## Runtime internals

- `ModelRegistry` resolves exact model revision, model license, preprocessing version and hardware capabilities, not an implicit `latest`.
- `DevicePlanner` checks MPS availability, available memory and operator compatibility; accepts CPU fallback with status. CUDA is optional and isolated in GPU workers.
- `DecodeService` guards decompression bombs, invalid metadata, oversized dimensions and allowed MIME. Decode in restricted process for untrusted media when exposed over HTTP.
- `BatchScheduler` dynamically groups by image dimensions/memory; retries transient resource exhaustion by reducing batch size with bounded attempts and emits explicit `resource_fallback` events.
- `Predictor` returns typed predictions with raw model score and optional separately calibrated probability; a missing calibration is `null` (not confidence 1.0).
- `Evaluator` consumes only a read-only locked split and emits per-sample predictions, metrics and errors; no training writes allowed.
- `Trainer` snapshots recipe/config/weights/optimizer states for resumability. On MPS OOM, checkpoint, reduce batch size or fail explicitly; do not claim equivalence if hyperparameters changed.

## Library tests

`pytest` unit tests with tiny deterministic fixtures; property tests for splits and transforms; parity harness against TS public schemas; CPU CI always green; MPS/CUDA integration optional on actual hardware with recorded environment; publish only from a signed/tagged release and build provenance.
