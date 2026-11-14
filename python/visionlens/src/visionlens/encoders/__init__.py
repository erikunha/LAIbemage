"""The encoders: the model adapters and the weights they load.

The encoders are the side of the runtime that touches model weights. They
are the only place where a fetch is possible, and every fetch passes the
gates of `weights.py` first.
"""

from __future__ import annotations

from .weights import (
    ALLOWED_REDIRECT_HOSTS,
    ALLOWED_SOURCES,
    CACHE_CORRUPT,
    DIGEST_MISMATCH,
    LICENSE_FORBIDDEN,
    MODEL_ID_UNSAFE,
    MODEL_USES,
    REVISION_NOT_PINNED,
    SAFE_WEIGHTS_SUFFIX,
    SOURCE_NOT_ALLOWED,
    SUPPORTED_TRUST_POLICIES,
    TRUST_POLICY_UNSUPPORTED,
    UNSAFE_FORMAT,
    USE_NOT_KNOWN,
    AuthorizedWeights,
    DownloadPermission,
    LoadedWeights,
    WeightsRequest,
    authorize_weights_download,
    cache_path,
    check_license,
    check_model_id,
    check_safetensors,
    check_source,
    check_trust_policy,
    digest_of_bytes,
    fetch_chunks,
    load_weights,
)

__all__ = [
    "ALLOWED_REDIRECT_HOSTS",
    "ALLOWED_SOURCES",
    "CACHE_CORRUPT",
    "DIGEST_MISMATCH",
    "LICENSE_FORBIDDEN",
    "MODEL_ID_UNSAFE",
    "MODEL_USES",
    "REVISION_NOT_PINNED",
    "SAFE_WEIGHTS_SUFFIX",
    "SOURCE_NOT_ALLOWED",
    "SUPPORTED_TRUST_POLICIES",
    "TRUST_POLICY_UNSUPPORTED",
    "UNSAFE_FORMAT",
    "USE_NOT_KNOWN",
    "AuthorizedWeights",
    "DownloadPermission",
    "LoadedWeights",
    "WeightsRequest",
    "authorize_weights_download",
    "cache_path",
    "check_license",
    "check_model_id",
    "check_safetensors",
    "check_source",
    "check_trust_policy",
    "digest_of_bytes",
    "fetch_chunks",
    "load_weights",
]
