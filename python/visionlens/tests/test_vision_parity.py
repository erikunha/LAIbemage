"""The golden parity on the Python side.

Both sides read the same golden file, so a change to one of them alone
breaks one of the two runs. The Python side proves three things here:

  - the config fingerprint it computes is the one the golden file names,
    and the golden file was written by the live TypeScript implementation,
    so the two implementations agree byte for byte;
  - the manifest of the golden artifact validates against the JSON Schema
    generated from the TypeScript schema;
  - the golden vectors and the vectors of the artifact agree inside the
    tolerance the golden file documents.

The vector comparison runs here without the heavy stack: the artifact is
committed, and the comparison is between the file and the golden file.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any, Dict, List

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.inference.manifest_schema import (
    load_manifest_schema,
    validate_against_schema,
)
from visionlens.runtime.fingerprint import fingerprint_v2

#: The repository root, from this file.
REPO_ROOT = Path(__file__).resolve().parents[3]

#: The golden file both sides read.
GOLDEN_PATH = REPO_ROOT / "benchmarks" / "parity" / "vision-embed.golden.json"

#: The committed artifact of the golden run.
ARTIFACT_DIR = REPO_ROOT / "benchmarks" / "parity" / "vision-embed.artifact"

#: The JSON Schema generated from the TypeScript schema.
SCHEMA_PATH = (
    REPO_ROOT
    / "packages"
    / "core"
    / "src"
    / "adapter"
    / "embedding-manifest.schema.json"
)


def _golden() -> Dict[str, Any]:
    return json.loads(GOLDEN_PATH.read_text(encoding="utf8"))


def _artifact_vectors() -> List[List[float]]:
    import array

    payload = array.array("f")
    payload.frombytes((ARTIFACT_DIR / "vectors.f32").read_bytes())
    manifest = json.loads((ARTIFACT_DIR / "manifest.json").read_text(encoding="utf8"))
    dimension = int(manifest["dimension"])
    return [
        list(payload[index * dimension : (index + 1) * dimension])
        for index in range(len(payload) // dimension)
    ]


def _cosine(left: List[float], right: List[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def test_the_python_fingerprint_is_the_one_the_golden_file_names():
    # SC-003: the golden file was written by the live TypeScript
    # implementation, so this equality IS the byte-identity of the two.
    golden = _golden()

    computed = fingerprint_v2(golden["config"])

    assert computed == golden["configFingerprint"]
    assert computed.startswith("fp2:")
    assert len(computed) == len("fp2:") + 16


def test_the_golden_file_carries_the_digest_of_its_vectors():
    golden = _golden()

    payload = bytearray()
    for image in golden["images"]:
        payload += image["name"].encode("utf-8") + b"\x00"
        payload += image["sha256"].encode("utf-8") + b"\x00"
        import array

        packed = array.array("f", (float(value) for value in image["vector"]))
        payload += packed.tobytes()

    assert hashlib.sha256(bytes(payload)).hexdigest() == golden["vectorsDigest"]


def test_the_manifest_validates_against_the_generated_json_schema():
    # FR-013: the same manifest validates against the schema generated
    # from the TypeScript one.
    schema = load_manifest_schema(SCHEMA_PATH)
    manifest = json.loads((ARTIFACT_DIR / "manifest.json").read_text(encoding="utf8"))

    issues = validate_against_schema(manifest, schema)

    assert issues == []


def test_the_manifest_is_refused_when_a_field_is_removed():
    schema = load_manifest_schema(SCHEMA_PATH)
    manifest = json.loads((ARTIFACT_DIR / "manifest.json").read_text(encoding="utf8"))
    del manifest["weightsDigest"]

    issues = validate_against_schema(manifest, schema)

    assert any("weightsDigest" in issue for issue in issues)


def test_the_manifest_is_refused_when_a_field_is_of_the_wrong_type():
    schema = load_manifest_schema(SCHEMA_PATH)
    manifest = json.loads((ARTIFACT_DIR / "manifest.json").read_text(encoding="utf8"))
    manifest["dimension"] = "seven hundred and sixty-eight"

    issues = validate_against_schema(manifest, schema)

    assert any("dimension" in issue for issue in issues)


def test_the_golden_vectors_and_the_artifact_agree_inside_the_tolerance():
    golden = _golden()
    observed = _artifact_vectors()
    tolerance = golden["tolerance"]

    assert len(observed) == len(golden["images"])
    for image, vector in zip(golden["images"], observed):
        difference = max(abs(a - b) for a, b in zip(image["vector"], vector))
        similarity = _cosine(image["vector"], vector)
        assert difference <= tolerance["maxAbsoluteDifference"], image["name"]
        assert similarity >= tolerance["minCosineSimilarity"], image["name"]


def test_the_golden_set_is_the_committed_fixtures():
    golden = _golden()
    fixtures = sorted(
        (REPO_ROOT / "packages" / "core" / "tests" / "fixtures" / "images").glob("*.jpg")
    )

    assert [image["name"] for image in golden["images"]] == [path.name for path in fixtures]
    for image, path in zip(golden["images"], fixtures):
        assert image["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_golden_file_carries_the_model_and_the_preprocessing_of_the_record():
    golden = _golden()
    registry = json.loads((REPO_ROOT / "datasets" / "registry.json").read_text(encoding="utf8"))
    record = next(item for item in registry["models"] if item["modelId"] == "siglip2-base")

    assert golden["model"]["revision"] == record["revision"]
    assert golden["model"]["weightsDigest"] == record["sourceDigest"]
    assert golden["preprocessing"]["fingerprint"] == record["preprocessingFingerprint"]
