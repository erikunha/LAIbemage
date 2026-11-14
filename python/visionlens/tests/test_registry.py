"""Registry resolution and its explicit refusals."""

from __future__ import annotations

import dataclasses
import json
import socket
from pathlib import Path
from typing import Any

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.registry import (
    DEFAULT_MODELS,
    ModelNotFoundError,
    ModelRecordError,
    ModelRegistry,
    ModelRegistryError,
    ModelSpec,
    UnknownModelError,
    load_model_registry,
    record_from_mapping,
    resolve_model,
)

REGISTRY = ModelRegistry.default()

#: The tracked registry file, from the repository root.
REPO_ROOT = Path(__file__).resolve().parents[3]
TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"


def test_resolves_a_known_model_with_every_field():
    spec = REGISTRY.resolve("siglip2-base")
    assert spec.model_id == "siglip2-base"
    assert spec.revision == "r2026-03-01"
    assert spec.dimension == 768
    assert spec.device_support == ("cpu",)
    assert spec.license == "apache-2.0"
    assert "image-embedding" in spec.tasks


def test_default_registry_models_are_listed_sorted():
    assert REGISTRY.model_ids() == tuple(sorted(s.model_id for s in DEFAULT_MODELS))
    assert "siglip2-base" in REGISTRY
    assert len(REGISTRY) == len(DEFAULT_MODELS)


def test_unknown_model_is_refused_with_the_id_and_the_known_set():
    with pytest.raises(UnknownModelError) as excinfo:
        REGISTRY.resolve("gpt-5-vision")
    message = str(excinfo.value)
    assert "gpt-5-vision" in message
    assert "siglip2-base" in message
    assert excinfo.value.model_id == "gpt-5-vision"
    assert "siglip2-base" in excinfo.value.known_models


def test_floating_latest_revision_is_refused():
    with pytest.raises(ValueError, match="latest"):
        ModelSpec(model_id="siglip2-base", revision="latest", dimension=768)


def test_empty_identity_fields_are_refused():
    with pytest.raises(ValueError):
        ModelSpec(model_id="", revision="r1", dimension=8)
    with pytest.raises(ValueError):
        ModelSpec(model_id="m", revision="", dimension=8)


def test_bad_dimension_is_refused():
    with pytest.raises(ValueError, match="dimension"):
        ModelSpec(model_id="m", revision="r1", dimension=0)
    with pytest.raises(ValueError, match="dimension"):
        ModelSpec(model_id="m", revision="r1", dimension=-4)


def test_empty_device_support_is_refused():
    with pytest.raises(ValueError, match="device"):
        ModelSpec(model_id="m", revision="r1", dimension=8, device_support=())


def test_specs_are_immutable():
    spec = REGISTRY.resolve("clip-vit-b32")
    with pytest.raises(dataclasses.FrozenInstanceError):
        spec.dimension = 128  # type: ignore[misc]


def test_custom_registry_resolves_only_its_own_models():
    custom = ModelRegistry(
        {"only-one": ModelSpec(model_id="only-one", revision="r1", dimension=4)}
    )
    assert custom.model_ids() == ("only-one",)
    with pytest.raises(UnknownModelError):
        custom.resolve("siglip2-base")


# ---------------------------------------------------------------------------
# The model capability registry (spec 019, tasks 1.3 and 1.4).
#
# The simulated registry above is a frozen list of placeholders. The
# capability registry is the DATA: pinned records of the models the platform
# may run, read from datasets/registry.json. A record that cannot be trusted
# is refused, and the refusal names the offending field by the path the FILE
# uses, the same path the TypeScript reader names.
# ---------------------------------------------------------------------------


def _valid_dataset() -> dict[str, Any]:
    """A dataset entry that satisfies the registry schema."""
    return {
        "id": "fixture",
        "title": "A fixture dataset",
        "usage": "benchmark",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "commercialUse": True,
        "source": "https://example.test/source",
        "resource": "https://example.test/resource",
        "version": "v1",
        "archiveBytes": None,
        "etag": None,
        "parts": {"selected": ["alpha"], "rationale": "the fixture strata"},
        "sha256": None,
        "sha256PinnedAt": None,
        "attribution": "The fixture authors.",
        "fetchedAt": None,
        "notes": "",
    }


def _valid_entry() -> dict[str, Any]:
    """A model entry that satisfies the record, so a test varies one thing."""
    return {
        "modelId": "siglip2-base",
        "revision": "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2",
        "sourceUri": "https://example.test/model.safetensors",
        "sourceDigest": "612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b",
        "license": "apache-2.0",
        "licenseUrl": "https://www.apache.org/licenses/LICENSE-2.0",
        "commercialUse": True,
        "usageRestrictions": "",
        "requiredExtras": ["vision"],
        "tasks": ["image-embedding"],
        "preprocessingFingerprint": "fp2:83adc4ef99979644",
        "deviceSupport": ["cpu"],
        "inputImageSize": {"width": 224, "height": 224},
        "featureExtractor": "siglip_vision_model",
        "outputShape": {"dimension": 768},
        "latencyCostProfile": "unknown",
        "calibrationStatus": "uncalibrated",
        "trustPolicy": "allowlisted-pinned-safetensors-only",
        "attribution": "The fixture authors.",
        "notes": "",
    }


def _registry_file(tmp_path: Path, **overrides: Any) -> Path:
    """Write a registry file with the given top-level overrides."""
    payload: dict[str, Any] = {
        "schemaVersion": 2,
        "datasets": [_valid_dataset()],
    }
    payload.update(overrides)
    target = tmp_path / "registry.json"
    target.write_text(json.dumps(payload), encoding="utf8")
    return target


def test_the_tracked_registry_carries_the_pinned_model_record():
    registry = load_model_registry(str(TRACKED_REGISTRY))
    record = resolve_model(registry, "siglip2-base")

    # A pinned record: an exact revision and the digest of the real bytes.
    assert record.revision == "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
    assert record.source_digest == (
        "612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b"
    )
    assert record.license == "apache-2.0"
    assert record.commercial_use is True
    assert record.device_support == ("cpu",)
    assert record.output_dimension == 768
    assert record.input_image_size == (224, 224)
    assert record.required_extras == ("vision",)


def test_a_record_with_no_digest_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["sourceDigest"] = ""

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.sourceDigest"
    assert "models.0.sourceDigest" in str(excinfo.value)


def test_a_record_with_a_malformed_digest_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["sourceDigest"] = "not-a-digest"

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.sourceDigest"


def test_a_record_with_no_license_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["license"] = ""

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.license"


def test_a_record_with_no_device_support_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["deviceSupport"] = []

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.deviceSupport"


def test_a_device_outside_the_vocabulary_is_refused_naming_the_field():
    # The pack fixes the vocabulary: cpu, mps, cuda. A record that claims a
    # device the platform does not have is refused, not accepted.
    entry = _valid_entry()
    entry["deviceSupport"] = ["tpu"]

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.deviceSupport.0"
    assert "cpu" in str(excinfo.value)


def test_a_weights_location_that_is_not_a_url_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["sourceUri"] = "not-a-url"

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.sourceUri"


def test_a_license_location_that_is_not_a_url_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["licenseUrl"] = "not-a-url"

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.licenseUrl"


def test_an_empty_trust_policy_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["trustPolicy"] = ""

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.trustPolicy"


def test_an_empty_attribution_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["attribution"] = ""

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.attribution"


def test_the_floating_revision_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["revision"] = "latest"

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.revision"
    assert "latest" in str(excinfo.value)


def test_a_record_without_a_field_is_refused_naming_the_field():
    entry = _valid_entry()
    del entry["sourceDigest"]

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.sourceDigest"


def test_a_missing_optional_looking_field_is_still_required():
    # The TypeScript reader requires these fields; a reader that defaults
    # them would accept a record the other reader refuses.
    for field in ("usageRestrictions", "requiredExtras", "notes"):
        entry = _valid_entry()
        del entry[field]
        with pytest.raises(ModelRecordError) as excinfo:
            record_from_mapping(entry)
        assert excinfo.value.field == "models.0." + field


def test_an_unknown_field_is_refused_naming_it():
    # A misspelled field nobody sees is a field nobody maintains.
    entry = _valid_entry()
    entry["mysteryField"] = "surprise"

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.mysteryField"


def test_an_unknown_field_in_a_nested_object_is_refused_naming_it():
    entry = _valid_entry()
    entry["inputImageSize"] = {"width": 224, "height": 224, "depth": 3}

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.inputImageSize.depth"


def test_a_non_boolean_commercial_use_is_refused_naming_the_field():
    # bool("false") is True, so a string here would quietly claim a
    # commercial use the license may forbid.
    entry = _valid_entry()
    entry["commercialUse"] = "false"

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.commercialUse"


def test_a_non_integer_output_dimension_is_refused_naming_the_path():
    entry = _valid_entry()
    entry["outputShape"] = {"dimension": "768"}

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.outputShape.dimension"


def test_a_missing_input_width_is_refused_naming_the_path():
    entry = _valid_entry()
    del entry["inputImageSize"]["width"]

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.inputImageSize.width"


def test_a_zero_input_width_is_refused_naming_the_path():
    entry = _valid_entry()
    entry["inputImageSize"] = {"width": 0, "height": 224}

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.inputImageSize.width"


def test_a_non_string_revision_is_refused_naming_the_field():
    entry = _valid_entry()
    entry["revision"] = 75

    with pytest.raises(ModelRecordError) as excinfo:
        record_from_mapping(entry)
    assert excinfo.value.field == "models.0.revision"


def test_an_unknown_model_is_refused_naming_the_model_and_the_registry(tmp_path: Path):
    target = _registry_file(tmp_path, models=[_valid_entry()])
    registry = load_model_registry(str(target))

    with pytest.raises(ModelNotFoundError) as excinfo:
        resolve_model(registry, "not-a-model")
    message = str(excinfo.value)
    assert "not-a-model" in message
    assert str(target) in message
    assert "siglip2-base" in message


def test_resolving_a_model_performs_no_network_access(monkeypatch: pytest.MonkeyPatch):
    """Resolving a model reads the registry and nothing else.

    The record names which bytes the model is; fetching them is a separate,
    explicitly permitted act. A resolution that reached the network would
    make the digest a decoration instead of a promise.
    """

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("resolving a model must never reach the network")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)

    registry = load_model_registry(str(TRACKED_REGISTRY))
    record = resolve_model(registry, "siglip2-base")
    assert record.model_id == "siglip2-base"


def test_a_registry_without_the_models_key_resolves_no_model(tmp_path: Path):
    target = _registry_file(tmp_path, schemaVersion=1)
    registry = load_model_registry(str(target))

    assert len(registry) == 0
    with pytest.raises(ModelNotFoundError):
        resolve_model(registry, "siglip2-base")


def test_a_version_1_registry_that_carries_model_records_is_refused(tmp_path: Path):
    # Version 1 is the format before the models array existed. A file that
    # claims version 1 and carries records anyway is inconsistent.
    target = _registry_file(tmp_path, schemaVersion=1, models=[_valid_entry()])

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "models"


def test_a_registry_in_an_unknown_format_version_is_refused(tmp_path: Path):
    target = _registry_file(tmp_path, schemaVersion=99)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "schemaVersion"
    assert "99" in str(excinfo.value)


def test_a_registry_with_an_unknown_top_level_field_is_refused(tmp_path: Path):
    target = _registry_file(tmp_path, extra=True)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "extra"


def test_a_registry_without_datasets_is_refused(tmp_path: Path):
    target = tmp_path / "registry.json"
    target.write_text(json.dumps({"schemaVersion": 2}), encoding="utf8")

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "datasets"


def test_a_registry_file_that_is_not_json_is_refused(tmp_path: Path):
    target = tmp_path / "registry.json"
    target.write_text("{not json", encoding="utf8")

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert "JSON" in str(excinfo.value)


def test_a_registry_file_that_is_absent_is_refused(tmp_path: Path):
    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(tmp_path / "absent.json"))
    assert "cannot be read" in str(excinfo.value)


# ---------------------------------------------------------------------------
# The dataset half of the envelope (the mirror of the dataset schema).
#
# The dataset schema belongs to the dataset reader in TypeScript, and the
# Python reader mirrors it: a registry file that one reader calls usable the
# other reader must call usable too, or the two disagree about what the
# platform may run. The constitutional rule is the one that matters most: a
# dataset with no licence may not be used.
# ---------------------------------------------------------------------------


def _registry_with_dataset(tmp_path: Path, dataset: dict[str, Any]) -> Path:
    payload = {"schemaVersion": 2, "datasets": [dataset]}
    target = tmp_path / "registry.json"
    target.write_text(json.dumps(payload), encoding="utf8")
    return target


def test_a_dataset_without_a_license_is_refused_naming_the_field(tmp_path: Path):
    dataset = _valid_dataset()
    del dataset["license"]
    target = _registry_with_dataset(tmp_path, dataset)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "datasets.0.license"


def test_a_dataset_with_an_empty_license_is_refused_naming_the_field(tmp_path: Path):
    dataset = _valid_dataset()
    dataset["license"] = ""
    target = _registry_with_dataset(tmp_path, dataset)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "datasets.0.license"


def test_a_dataset_with_an_unknown_field_is_refused_naming_it(tmp_path: Path):
    dataset = _valid_dataset()
    dataset["mysteryField"] = "x"
    target = _registry_with_dataset(tmp_path, dataset)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "datasets.0.mysteryField"


def test_a_dataset_with_an_unknown_usage_is_refused_naming_the_field(tmp_path: Path):
    dataset = _valid_dataset()
    dataset["usage"] = "training"
    target = _registry_with_dataset(tmp_path, dataset)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "datasets.0.usage"


def test_a_dataset_with_a_mistyped_field_is_refused_naming_the_field(tmp_path: Path):
    dataset = _valid_dataset()
    dataset["archiveBytes"] = "big"
    target = _registry_with_dataset(tmp_path, dataset)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "datasets.0.archiveBytes"


def test_a_dataset_with_a_sha256_without_its_timestamp_is_refused(tmp_path: Path):
    dataset = _valid_dataset()
    dataset["sha256"] = "612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b"
    target = _registry_with_dataset(tmp_path, dataset)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "datasets.0.sha256PinnedAt"


def test_a_dataset_with_a_fetched_at_without_an_offset_is_refused(tmp_path: Path):
    dataset = _valid_dataset()
    dataset["fetchedAt"] = "2026-01-01T00:00:00"
    target = _registry_with_dataset(tmp_path, dataset)

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "datasets.0.fetchedAt"


def test_a_valid_dataset_is_accepted(tmp_path: Path):
    target = _registry_with_dataset(tmp_path, _valid_dataset())

    registry = load_model_registry(str(target))
    assert len(registry) == 0


def test_a_boolean_schema_version_is_refused_naming_the_field(tmp_path: Path):
    # True == 1 in Python, so a boolean version would slip through the
    # version check as a version 1 registry.
    target = tmp_path / "registry.json"
    target.write_text(
        json.dumps({"schemaVersion": True, "datasets": [_valid_dataset()]}), encoding="utf8"
    )

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "schemaVersion"


def test_a_text_schema_version_is_refused_naming_the_field(tmp_path: Path):
    target = tmp_path / "registry.json"
    target.write_text(
        json.dumps({"schemaVersion": "2", "datasets": [_valid_dataset()]}), encoding="utf8"
    )

    with pytest.raises(ModelRegistryError) as excinfo:
        load_model_registry(str(target))
    assert excinfo.value.field == "schemaVersion"
