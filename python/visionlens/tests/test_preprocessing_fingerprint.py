"""The preprocessing fingerprint of the pinned model (spec 019, VLN-005).

The capability record of a real model carries the fingerprint of the
preprocessing it was measured with. That fingerprint is only worth
something if anyone can recompute it, so this file pins the processor
config of the pinned revision and recomputes the fingerprint with the
repository's own algorithm.

The config is the one google/siglip2-base-patch16-224 ships at commit
75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2, byte for byte, and the digest
below is the sha256 of those bytes. The test that reads the tracked
registry and compares it with the recomputed value is the guard: a
fingerprint nobody can derive is a decoration.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.encoder import (
    PREPROCESSING_COMPONENTS,
    components_from_preprocessor_config,
    fingerprint_of_components,
    preprocessing_fingerprint,
)
from visionlens.registry import ModelSpec

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

#: The sha256 of the pinned bytes above.
PINNED_PREPROCESSOR_CONFIG_DIGEST = (
    "9b36b57ebaf20f09bf4c22100ccc21877ea6bfe5aead0c00c59f8af8ccefacfc"
)

#: The fingerprint the tracked record carries, recomputed here from the
#: pinned config with the repository's own algorithm.
EXPECTED_FINGERPRINT = "fp2:83adc4ef99979644"


def _pinned_config() -> dict[str, Any]:
    return json.loads(PINNED_PREPROCESSOR_CONFIG.decode("utf8"))


def test_the_pinned_config_is_the_one_the_digest_names():
    digest = hashlib.sha256(PINNED_PREPROCESSOR_CONFIG).hexdigest()
    assert digest == PINNED_PREPROCESSOR_CONFIG_DIGEST


def test_the_config_yields_the_canonical_components():
    components = components_from_preprocessor_config(_pinned_config())

    assert components == {
        "resize": {"height": 224, "width": 224},
        "interpolation": "bilinear",
        "rescale": {"factor": 0.00392156862745098},
        "normalize": {"mean": [0.5, 0.5, 0.5], "std": [0.5, 0.5, 0.5]},
    }


def test_the_fingerprint_of_the_pinned_config_is_reproducible():
    fingerprint = fingerprint_of_components(
        components_from_preprocessor_config(_pinned_config())
    )

    assert fingerprint == EXPECTED_FINGERPRINT


def test_the_tracked_record_carries_that_fingerprint():
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    records = registry["models"]
    siglip = next(record for record in records if record["modelId"] == "siglip2-base")

    assert siglip["preprocessingFingerprint"] == EXPECTED_FINGERPRINT


def test_the_simulated_pipeline_has_its_own_fingerprint():
    # The simulated encoder is not this model: it resizes to 256 and crops,
    # so its fingerprint differs from the real model's. Two fingerprints for
    # two pipelines, and neither is a default for the other.
    simulated = preprocessing_fingerprint(
        ModelSpec(model_id="siglip2-base", revision="r2026-03-01", dimension=768)
    )

    assert simulated == fingerprint_of_components(PREPROCESSING_COMPONENTS)
    assert simulated != EXPECTED_FINGERPRINT


@pytest.mark.parametrize(
    "broken",
    [
        {"size": {"height": 224}},
        {"size": {"height": 224, "width": 224}, "resample": 99},
        {"size": {"height": 224, "width": 224}, "rescale_factor": "0.5"},
        {"size": {"height": 224, "width": 224}, "image_mean": []},
    ],
)
def test_a_config_that_cannot_describe_the_preprocessing_is_refused(broken: dict[str, Any]):
    config = _pinned_config()
    config.update(broken)

    with pytest.raises(ValueError):
        components_from_preprocessor_config(config)
