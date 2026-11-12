"""The deterministic simulated encoder.

The same image bytes plus the same model id always produce the same vector,
and the vector depends on the bytes, so a changed image changes the vector.
The derivation reads the ModelSpec (revision and dimension), so a real
encoder replaces this module behind the same two functions,
embed_bytes and preprocessing_fingerprint, without touching the protocol.
Pure standard library: no numpy, no torch, no network.
"""

from __future__ import annotations

import hashlib
import json
from typing import Mapping

from .registry import ModelSpec

_ENCODER_DOMAIN = b"visionlens.encoder.v1"

#: The dtype label every simulated embed result reports.
DTYPE = "float32"

#: Components of the canonical preprocessing specification. The fingerprint
#: is derived only from these, so two models sharing the preprocessing share
#: the fingerprint.
PREPROCESSING_COMPONENTS: dict[str, object] = {
    "resize": {"shortestEdge": 256, "crop": [256, 256]},
    "interpolation": "bilinear",
    "rescale": {"factor": 0.00392156862745098},
    "normalize": {
        "mean": [0.5, 0.5, 0.5],
        "std": [0.5, 0.5, 0.5],
    },
}


def _seed(model: ModelSpec, image: bytes) -> bytes:
    return (
        _ENCODER_DOMAIN
        + b"\0"
        + model.model_id.encode("utf-8")
        + b"\0"
        + model.revision.encode("utf-8")
        + b"\0"
        + image
    )


def unit_interval(seed: bytes, index: int) -> float:
    """Return a deterministic float in [0, 1) derived from a seed and index."""
    digest = hashlib.sha256(seed + index.to_bytes(4, "big")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def embed_bytes(image: bytes, model: ModelSpec) -> list[float]:
    """Embed one image content for one model, deterministically.

    The vector length equals the model dimension and every component lies in
    [-1.0, 1.0], rounded to six decimals so the JSON form is stable.
    """
    if not isinstance(image, (bytes, bytearray)):
        raise TypeError("image must be bytes")
    seed = _seed(model, bytes(image))
    vector: list[float] = []
    for index in range(model.dimension):
        scaled = unit_interval(seed, index) * 2.0 - 1.0
        vector.append(round(scaled, 6))
    return vector


def canonical_json(payload: Mapping[str, object]) -> str:
    """Serialize with recursively sorted keys, the canonical form for digests."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest_of(payload: Mapping[str, object]) -> str:
    """Return the sha256 hex digest of the canonical JSON of a payload."""
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def preprocessing_fingerprint(model: ModelSpec) -> str:
    """Return the fp2 form preprocessing fingerprint of the model's pipeline."""
    canonical = canonical_json({"preprocessing": PREPROCESSING_COMPONENTS})
    return "fp2:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
