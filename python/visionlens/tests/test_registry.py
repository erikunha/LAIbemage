"""Registry resolution and its explicit refusals."""

from __future__ import annotations

import dataclasses

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.registry import DEFAULT_MODELS, ModelRegistry, ModelSpec, UnknownModelError

REGISTRY = ModelRegistry.default()


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
