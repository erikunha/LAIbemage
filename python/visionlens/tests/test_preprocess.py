"""The canonical preprocessing, and the fingerprint that names it.

Two runs with different preprocessing cannot be compared as equivalent,
so the preprocessing is a record: the specification, its fingerprint and
the pixels it produces. The fingerprint of the pinned model is the one
the registry record carries, and it is recomputed here from the same
pinned config, so a fingerprint nobody can derive is a decoration.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.io.preprocess import (
    PreprocessingSpec,
    spec_of_record,
)
from visionlens.registry.loader import record_from_mapping

#: The repository root, from this file.
REPO_ROOT = Path(__file__).resolve().parents[3]

#: The tracked registry, the file that carries the record.
TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"

#: The processor config of the pinned revision, byte for byte.
PINNED_PREPROCESSOR_CONFIG = b"""{
  "do_convert_rgb": null,
  "do_normalize": true,
  "do_rescale": true,
  "do_resize": true,
  "image_mean": [
    0.5,
    0.5,
    0.5
  ],
  "image_processor_type": "SiglipImageProcessor",
  "image_std": [
    0.5,
    0.5,
    0.5
  ],
  "processor_class": "SiglipProcessor",
  "resample": 2,
  "rescale_factor": 0.00392156862745098,
  "size": {
    "height": 224,
    "width": 224
  }
}
"""

#: The fingerprint the tracked record carries.
EXPECTED_FINGERPRINT = "fp2:83adc4ef99979644"


def _config() -> dict[str, object]:
    return json.loads(PINNED_PREPROCESSOR_CONFIG.decode("utf8"))


def _tracked_record():
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    entry = next(item for item in registry["models"] if item["modelId"] == "siglip2-base")
    return record_from_mapping(entry)


def test_the_specification_of_the_pinned_config_carries_the_record_fingerprint():
    spec = PreprocessingSpec.from_preprocessor_config(_config())

    assert spec.fingerprint() == EXPECTED_FINGERPRINT


def test_the_specification_matches_the_tracked_record():
    record = _tracked_record()

    spec = spec_of_record(record, _config())

    assert spec.matches(record.preprocessing_fingerprint)
    assert spec.height == 224
    assert spec.width == 224
    assert spec.interpolation == "bilinear"
    assert spec.rescale_factor == pytest.approx(1.0 / 255.0)
    assert spec.mean == (0.5, 0.5, 0.5)
    assert spec.std == (0.5, 0.5, 0.5)


def test_a_specification_that_is_not_the_record_s_specification_is_refused():
    # The record names the fingerprint of the preprocessing it was
    # measured with: a different preprocessing is a different run.
    record = _tracked_record()
    config = _config()
    config["size"] = {"height": 256, "width": 256}

    with pytest.raises(ValueError) as excinfo:
        spec_of_record(record, config)

    assert record.preprocessing_fingerprint in str(excinfo.value)


def test_two_specifications_that_differ_have_different_fingerprints():
    one = PreprocessingSpec.from_preprocessor_config(_config())
    config = _config()
    config["image_mean"] = [0.4, 0.5, 0.5]
    other = PreprocessingSpec.from_preprocessor_config(config)

    assert one.fingerprint() != other.fingerprint()


def test_the_specification_produces_the_pixels_it_describes():
    from PIL import Image

    spec = PreprocessingSpec.from_preprocessor_config(_config())
    image = Image.new("RGB", (8, 4), (255, 255, 255))

    result = spec.apply(image)

    assert result.shape == (3, 224, 224)
    assert len(result.values) == 3 * 224 * 224
    # A white pixel becomes 1.0 before the normalization, and 1.0 after it.
    assert result.values[0] == pytest.approx(1.0)
    assert result.values[1] == pytest.approx(1.0)
    assert result.values[2] == pytest.approx(1.0)


def test_the_specification_normalizes_a_black_pixel_to_minus_one():
    from PIL import Image

    spec = PreprocessingSpec.from_preprocessor_config(_config())
    image = Image.new("RGB", (4, 4), (0, 0, 0))

    result = spec.apply(image)

    assert result.values[0] == pytest.approx(-1.0)


def test_the_same_image_and_the_same_specification_produce_the_same_digest():
    from PIL import Image

    spec = PreprocessingSpec.from_preprocessor_config(_config())
    image = Image.new("RGB", (8, 4), (10, 20, 30))

    first = spec.apply(image).digest()
    second = spec.apply(image).digest()

    assert first == second
    assert len(first) == 64


def test_a_specification_that_cannot_describe_a_preprocessing_is_refused():
    with pytest.raises(ValueError):
        PreprocessingSpec.from_preprocessor_config({"size": {"height": 224}})

    with pytest.raises(ValueError):
        PreprocessingSpec(height=0, width=224, interpolation="bilinear",
                          rescale_factor=1 / 255, mean=(0.5,) * 3, std=(0.5,) * 3)

    with pytest.raises(ValueError):
        PreprocessingSpec(height=224, width=224, interpolation="magic",
                          rescale_factor=1 / 255, mean=(0.5,) * 3, std=(0.5,) * 3)
