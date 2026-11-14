"""visionlens: a local-first visual AI runtime, fully simulated.

The package ships the deterministic simulated encoder, the model registry, the
JSONL worker speaking the frozen visionlens.worker.v1 protocol and the typed
public facade. The runtime needs no numpy, no torch and no network; the only
third-party package in the base install is Pydantic, which carries the
versioned configuration and the typed records of the facade.

Committed code cites the pack paths under docs/vnext/ for the frozen wire
statements; this surface re-exports only what callers need.
"""

from __future__ import annotations

from .api import Datasets, VisionLens
from .capabilities import (
    CAPABILITIES_SCHEMA_VERSION,
    EXTRA_NAMES,
    Capabilities,
    ExtraCapability,
    resolve_capabilities,
)
from .config import CONFIG_SCHEMA_VERSION, SUPPORTED_DEVICES, LocalConfig
from .data.inspect import DatasetInspection, inspect_image
from .downloads import (
    DOWNLOAD_REFUSED,
    AuthorizedDownload,
    DownloadProvenance,
    DownloadRefusedError,
    authorize_download,
)
from .encoder import DTYPE, canonical_json, digest_of, embed_bytes, preprocessing_fingerprint
from .encoders import (
    AuthorizedWeights,
    DownloadPermission,
    LoadedWeights,
    WeightsRequest,
    authorize_weights_download,
    load_weights,
)
from .inference.embedder import (
    EmbedAsset,
    EmbedError,
    EmbedRequest,
    EmbedResult,
    VisionEmbedder,
)
from .io import DecodedImage, DecodeService
from .errors import (
    ClientClosedError,
    ConfigInvalidError,
    ConfigVersionUnsupportedError,
    ErrorCode,
    ImageDimensionsExceededError,
    LibraryError,
    LibraryErrorCode,
    MimeMismatchError,
    PathNotFoundError,
    PathOutsideRootError,
    UnsupportedDeviceError,
    UnsupportedFileTypeError,
    WorkerError,
    is_retryable,
)
from .registry import (
    DEFAULT_MODELS,
    ModelCapabilityRegistry,
    ModelNotFoundError,
    ModelRecord,
    ModelRecordError,
    ModelRegistry,
    ModelRegistryError,
    ModelSpec,
    UnknownModelError,
    load_model_registry,
    resolve_model,
)
from .runtime import DevicePlan, DevicePlanner
from .worker import Worker

__version__ = "0.1.0"

__all__ = [
    "CAPABILITIES_SCHEMA_VERSION",
    "CONFIG_SCHEMA_VERSION",
    "DOWNLOAD_REFUSED",
    "DTYPE",
    "DEFAULT_MODELS",
    "EXTRA_NAMES",
    "SUPPORTED_DEVICES",
    "AuthorizedDownload",
    "AuthorizedWeights",
    "Capabilities",
    "ClientClosedError",
    "ConfigInvalidError",
    "ConfigVersionUnsupportedError",
    "DatasetInspection",
    "Datasets",
    "DecodeService",
    "DecodedImage",
    "DevicePlan",
    "EmbedAsset",
    "EmbedError",
    "EmbedRequest",
    "EmbedResult",
    "DevicePlanner",
    "DownloadPermission",
    "DownloadProvenance",
    "DownloadRefusedError",
    "ErrorCode",
    "ExtraCapability",
    "ImageDimensionsExceededError",
    "LibraryError",
    "LibraryErrorCode",
    "LoadedWeights",
    "LocalConfig",
    "MimeMismatchError",
    "ModelCapabilityRegistry",
    "ModelNotFoundError",
    "ModelRecord",
    "ModelRecordError",
    "ModelRegistry",
    "ModelRegistryError",
    "ModelSpec",
    "PathNotFoundError",
    "PathOutsideRootError",
    "UnknownModelError",
    "UnsupportedDeviceError",
    "UnsupportedFileTypeError",
    "VisionEmbedder",
    "VisionLens",
    "WeightsRequest",
    "Worker",
    "WorkerError",
    "__version__",
    "authorize_download",
    "authorize_weights_download",
    "canonical_json",
    "digest_of",
    "embed_bytes",
    "inspect_image",
    "is_retryable",
    "load_model_registry",
    "load_weights",
    "preprocessing_fingerprint",
    "resolve_capabilities",
    "resolve_model",
]
