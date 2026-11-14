"""The SigLIP2 adapter: the bytes it loads and the ones it refuses.

The adapter builds a model from a local directory, so the directory is
the trust boundary: the bytes nobody verified would be executed by the
model. The refusal is therefore checked before the heavy stack is
imported, and it names both digests.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.encoders.siglip2 import Siglip2Encoder
from visionlens.errors import ModelRunFailedError
from visionlens.io.preprocess import PreprocessedImage, PreprocessingSpec
from visionlens.registry.loader import record_from_mapping

#: The repository root, from this file.
REPO_ROOT = Path(__file__).resolve().parents[3]

#: The tracked registry, the file that carries the record.
TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"


def _tracked_record():
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    entry = next(
        item for item in registry["models"] if item["modelId"] == "siglip2-base"
    )
    return record_from_mapping(entry)


def _one_image() -> PreprocessedImage:
    """One preprocessed image, so the adapter reaches the model."""
    spec = PreprocessingSpec(
        height=2,
        width=2,
        interpolation="bilinear",
        rescale_factor=1.0 / 255.0,
        mean=(0.5, 0.5, 0.5),
        std=(0.5, 0.5, 0.5),
    )
    return PreprocessedImage(
        spec=spec, width=2, height=2, channels=3, values=(0.0,) * 12
    )


def _model_dir(tmp_path: Path, payload: bytes) -> Path:
    directory = tmp_path / "model"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "model.safetensors").write_bytes(payload)
    (directory / "config.json").write_text("{}", encoding="utf8")
    return directory


def test_a_directory_without_weights_is_refused(tmp_path: Path):
    directory = tmp_path / "model"
    directory.mkdir(parents=True, exist_ok=True)

    encoder = Siglip2Encoder(_tracked_record(), directory)

    with pytest.raises(ModelRunFailedError) as excinfo:
        encoder.embed([_one_image()])

    assert "model.safetensors" in str(excinfo.value)


def test_a_directory_with_other_weights_is_refused(tmp_path: Path):
    # The record names the digest of the bytes, and a directory that
    # carries other bytes is refused before a model is built from them.
    directory = _model_dir(tmp_path, b"not the weights of the record")

    encoder = Siglip2Encoder(_tracked_record(), directory)

    with pytest.raises(ModelRunFailedError) as excinfo:
        encoder.embed([_one_image()])

    assert _tracked_record().source_digest in str(excinfo.value)


def test_the_refusal_names_both_digests(tmp_path: Path):
    from visionlens.hashing import sha256_of_bytes

    payload = b"not the weights of the record"
    directory = _model_dir(tmp_path, payload)

    encoder = Siglip2Encoder(_tracked_record(), directory)

    with pytest.raises(ModelRunFailedError) as excinfo:
        encoder.embed([_one_image()])

    assert sha256_of_bytes(payload) in str(excinfo.value)
