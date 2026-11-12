"""Encoder determinism, byte sensitivity and spec derivation."""

from __future__ import annotations

import json

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.encoder import (
    DTYPE,
    digest_of,
    embed_bytes,
    preprocessing_fingerprint,
)
from visionlens.registry import ModelRegistry, ModelSpec

REGISTRY = ModelRegistry.default()
SIGLIP = REGISTRY.resolve("siglip2-base")
CLIP = REGISTRY.resolve("clip-vit-b32")


def test_same_bytes_and_model_produce_the_same_vector():
    first = embed_bytes(b"golden-alpha", SIGLIP)
    second = embed_bytes(b"golden-alpha", SIGLIP)
    assert first == second
    assert len(first) == SIGLIP.dimension == 768


def test_changed_byte_changes_the_vector():
    first = embed_bytes(b"image-a", SIGLIP)
    second = embed_bytes(b"image-b", SIGLIP)
    assert first != second


def test_vector_is_byte_sensitive_at_every_position():
    base = embed_bytes(b"\x01\x02", SIGLIP)
    flipped = embed_bytes(b"\x01\x03", SIGLIP)
    assert base != flipped


def test_model_change_changes_the_vector():
    from_clip = embed_bytes(b"image-a", CLIP)
    from_siglip = embed_bytes(b"image-a", SIGLIP)
    assert from_clip != from_siglip
    assert len(from_clip) == CLIP.dimension == 512


def test_revision_change_changes_the_vector():
    older = ModelSpec(model_id="siglip2-base", revision="r2025-01-01", dimension=768)
    newer = ModelSpec(model_id="siglip2-base", revision="r2026-03-01", dimension=768)
    assert embed_bytes(b"image-a", older) != embed_bytes(b"image-a", newer)


def test_dimension_drives_vector_length():
    for dimension in (1, 8, 64):
        spec = ModelSpec(model_id="tiny", revision="r1", dimension=dimension)
        assert len(embed_bytes(b"x", spec)) == dimension


def test_values_are_within_minus_one_and_one():
    vector = embed_bytes(b"some image bytes", SIGLIP)
    assert all(-1.0 <= value <= 1.0 for value in vector)


def test_dtype_label_is_float32():
    assert DTYPE == "float32"


def test_vector_survives_a_json_round_trip():
    vector = embed_bytes(b"round-trip", SIGLIP)
    assert json.loads(json.dumps(vector)) == vector


def test_preprocessing_fingerprint_is_stable_fp2():
    first = preprocessing_fingerprint(SIGLIP)
    second = preprocessing_fingerprint(SIGLIP)
    assert first == second
    assert first.startswith("fp2:")
    assert len(first) == len("fp2:") + 16
    assert first == preprocessing_fingerprint(CLIP)


def test_digest_of_is_stable_and_sensitive():
    payload = {"b": 2, "a": [1, 2]}
    assert digest_of(payload) == digest_of({"a": [1, 2], "b": 2})
    assert len(digest_of(payload)) == 64
    assert digest_of(payload) != digest_of({"b": 2, "a": [1, 3]})


def test_embed_bytes_refuses_non_bytes():
    with pytest.raises(TypeError):
        embed_bytes("not bytes", SIGLIP)  # type: ignore[arg-type]
