"""The model registry: capability records, the simulated runtime and resolution.

Two registries live here, and they are not the same thing:

  - the **capability registry** (`loader.py`, `record.py`) is the DATA: the
    pinned records of the models the platform may run, read from
    `datasets/registry.json`. A record names exact bytes, an exact revision,
    a license and the devices the model runs on, and it is refused when it
    cannot be trusted;
  - the **simulated registry** (`simulated.py`) is the frozen list of
    placeholder models the SIMULATED runtime derives deterministic vectors
    from. Its revisions are placeholders, not real commits. It carries the
    same model id as the capability record, and it describes the simulated
    runtime, never the checkpoint.

Resolving an encoder means reading the capability registry. The simulated
registry resolves nothing on disk.
"""

from __future__ import annotations

from .loader import (
    ModelCapabilityRegistry,
    ModelNotFoundError,
    ModelRegistryError,
    load_model_registry,
    model_records_by_id,
    record_from_mapping,
    resolve_model,
)
from .record import ModelRecord, ModelRecordError
from .simulated import DEFAULT_MODELS, ModelRegistry, ModelSpec, UnknownModelError

__all__ = [
    "DEFAULT_MODELS",
    "ModelCapabilityRegistry",
    "ModelNotFoundError",
    "ModelRecord",
    "ModelRecordError",
    "ModelRegistry",
    "ModelRegistryError",
    "ModelSpec",
    "UnknownModelError",
    "load_model_registry",
    "model_records_by_id",
    "record_from_mapping",
    "resolve_model",
]
