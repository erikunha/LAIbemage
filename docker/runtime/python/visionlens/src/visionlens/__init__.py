"""visionlens: a local-first visual AI runtime, fully simulated.

The package ships the deterministic simulated encoder, the model registry
and the JSONL worker speaking the frozen visionlens.worker.v1 protocol.
Everything runs on the standard library: no numpy, no torch, no network.

Committed code cites the pack paths under docs/vnext/ for the frozen wire
statements; this surface re-exports only what callers need.
"""

from __future__ import annotations

from .downloads import (
    DOWNLOAD_REFUSED,
    AuthorizedDownload,
    DownloadProvenance,
    DownloadRefusedError,
    authorize_download,
)
from .encoder import DTYPE, canonical_json, digest_of, embed_bytes, preprocessing_fingerprint
from .errors import ErrorCode, WorkerError, is_retryable
from .registry import DEFAULT_MODELS, ModelRegistry, ModelSpec, UnknownModelError
from .worker import Worker

__version__ = "0.1.0"

__all__ = [
    "DOWNLOAD_REFUSED",
    "DTYPE",
    "DEFAULT_MODELS",
    "AuthorizedDownload",
    "DownloadProvenance",
    "DownloadRefusedError",
    "ErrorCode",
    "ModelRegistry",
    "ModelSpec",
    "UnknownModelError",
    "Worker",
    "WorkerError",
    "__version__",
    "authorize_download",
    "canonical_json",
    "digest_of",
    "embed_bytes",
    "is_retryable",
    "preprocessing_fingerprint",
]
