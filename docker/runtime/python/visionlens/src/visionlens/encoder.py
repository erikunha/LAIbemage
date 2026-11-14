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
from typing import Any, Mapping

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
    """Serialize with recursively sorted keys, the canonical form for digests.

    The form is the one the live TypeScript implementation writes, so the
    two languages agree byte for byte
    (`packages/contracts/src/fingerprint.ts:33`).
    """
    from .runtime.fingerprint import canonical_json as _canonical_json

    return _canonical_json(payload)


def digest_of(payload: Mapping[str, object]) -> str:
    """Return the sha256 hex digest of the canonical JSON of a payload."""
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def fingerprint_of_components(components: Mapping[str, object]) -> str:
    """Return the fp2 form fingerprint of a preprocessing specification.

    The specification is the components themselves, so the fingerprint of a
    REAL model's preprocessing is computed by the same algorithm as the
    simulated one. A fingerprint nobody can recompute is a decoration.
    """
    canonical = canonical_json({"preprocessing": components})
    return "fp2:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def preprocessing_fingerprint(model: ModelSpec) -> str:
    """Return the fp2 form preprocessing fingerprint of the model's pipeline."""
    return fingerprint_of_components(PREPROCESSING_COMPONENTS)


#: The PIL resample codes a processor config may name, in PIL's own order.
_RESAMPLE_NAMES = {
    0: "nearest",
    1: "lanczos",
    2: "bilinear",
    3: "bicubic",
    4: "box",
    5: "hamming",
}


def components_from_preprocessor_config(config: Mapping[str, object]) -> dict[str, object]:
    """Return the preprocessing components of a processor config.

    The config is the one a model repository ships (the HuggingFace shape):
    the resize size, the resample code, the rescale factor and the
    normalization mean and standard deviation. Reading the components from the
    config is what makes the fingerprint of a pinned model reproducible: the
    config is pinned by revision, and this function turns it into the same
    canonical shape the simulated pipeline uses.

    A config that does not carry what the fingerprint needs is a refusal, not
    a default: a preprocessing the record cannot describe is a preprocessing
    nobody may claim.
    """
    if not isinstance(config, Mapping):
        raise ValueError("the preprocessor config must be an object")

    size = config.get("size")
    if not isinstance(size, Mapping):
        raise ValueError("the preprocessor config carries no size")
    height = size.get("height")
    width = size.get("width")
    if not isinstance(height, int) or not isinstance(width, int):
        raise ValueError("the preprocessor config carries no integer size")

    resample = config.get("resample")
    if resample is None:
        interpolation = "bilinear"
    elif isinstance(resample, int) and resample in _RESAMPLE_NAMES:
        interpolation = _RESAMPLE_NAMES[resample]
    else:
        raise ValueError("the preprocessor config carries an unknown resample code")

    factor = config.get("rescale_factor")
    if not isinstance(factor, (int, float)) or isinstance(factor, bool):
        raise ValueError("the preprocessor config carries no rescale factor")

    mean: Any = config.get("image_mean")
    std: Any = config.get("image_std")
    for value in (mean, std):
        if not isinstance(value, (list, tuple)) or not value:
            raise ValueError("the preprocessor config carries no normalization")

    return {
        "resize": {"height": height, "width": width},
        "interpolation": interpolation,
        "rescale": {"factor": float(factor)},
        "normalize": {"mean": [float(item) for item in mean], "std": [float(item) for item in std]},
    }
