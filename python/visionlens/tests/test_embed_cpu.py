"""The CPU embedding run: the artifacts, the manifest and the failures.

The run is the product of this ticket, so the tests prove what it
promises: the images embed in one operation, the vectors land on disk
and not in the frame, the manifest carries every field of FR-011, and a
value that does not exist reads `unknown`.

The encoder of these tests is a stub that implements the protocol, so
the suite proves the run without the heavy stack. The real model runs
in the recorded measurement, not in every test run.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Sequence

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.encoders.base import EncoderOutput
from visionlens.errors import ImageMetadataUnreadableError
from visionlens.inference.artifact import (
    MANIFEST_SCHEMA_VERSION,
    UNKNOWN,
    manifest_from_dict,
    read_embedding_artifact,
)
from visionlens.inference.batching import BatchScheduler
from visionlens.inference.embedder import EmbedAsset, EmbedRequest, VisionEmbedder
from visionlens.io.decode import DecodeService
from visionlens.io.preprocess import PreprocessingSpec
from visionlens.registry.loader import record_from_mapping
from visionlens.runtime.device import DevicePlanner

#: The repository root, from this file.
REPO_ROOT = Path(__file__).resolve().parents[3]

#: The committed fixture images.
FIXTURES_DIR = REPO_ROOT / "packages" / "core" / "tests" / "fixtures" / "images"

#: The tracked registry, the file that carries the record.
TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"


class _StubEncoder:
    """An encoder that implements the protocol without a model."""

    model_id = "stub"
    revision = "stub-revision"
    dimension = 4
    dtype = "float32"

    def __init__(self) -> None:
        self.calls: list[int] = []

    def embed(self, images: Sequence[Any]) -> EncoderOutput:
        self.calls.append(len(images))
        return EncoderOutput(
            vectors=tuple(tuple(float(index) for index in range(4)) for _ in images),
            dimension=self.dimension,
            dtype=self.dtype,
        )


def _record():
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    entry = next(item for item in registry["models"] if item["modelId"] == "siglip2-base")
    return record_from_mapping(entry)


def _spec() -> PreprocessingSpec:
    return PreprocessingSpec(
        height=8,
        width=8,
        interpolation="bilinear",
        rescale_factor=1.0 / 255.0,
        mean=(0.5, 0.5, 0.5),
        std=(0.5, 0.5, 0.5),
    )


def _embedder(tmp_path: Path, encoder: Any = None) -> VisionEmbedder:
    return VisionEmbedder(
        record=_record(),
        encoder=encoder or _StubEncoder(),
        spec=_spec(),
        decoder=DecodeService(FIXTURES_DIR),
        device=DevicePlanner({"cpu": True}).plan("cpu"),
        artifact_root=tmp_path / "artifacts-root",
        snapshot_id="snapshot-test",
    )


def _assets() -> tuple[EmbedAsset, ...]:
    return tuple(
        EmbedAsset(asset_id=path.name, path=path)
        for path in sorted(FIXTURES_DIR.glob("*.jpg"))
    )


def test_the_committed_fixtures_embed_in_one_operation(tmp_path: Path):
    # Task 2.1: the run returns the run id, the dimension, the dtype, the
    # count, the artifact digest and an empty error list.
    embedder = _embedder(tmp_path)

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    assert result.run_id
    assert result.dimension == 4
    assert result.dtype == "float32"
    assert result.count == len(_assets())
    assert result.artifact_sha256
    assert result.errors == ()
    assert result.device == "cpu"


def test_the_vectors_are_on_disk_and_the_frame_carries_no_payload(tmp_path: Path):
    # Task 2.2: the vectors are in the artifact, and the result carries
    # no base64 payload.
    embedder = _embedder(tmp_path)

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    artifact = read_embedding_artifact(result.artifact_path)
    assert artifact.vectors_path.is_file()
    assert artifact.vectors_path.read_bytes()
    assert artifact.manifest_path.is_file()
    frame = result.__dict__
    for value in frame.values():
        assert not isinstance(value, str) or "base64" not in value
    assert not hasattr(result, "vectors")


def test_the_manifest_carries_every_field_of_fr_011(tmp_path: Path):
    # Task 2.3: the manifest carries the schema version, the run id, the
    # model, the revision, the source, the digest, the preprocessing, the
    # snapshot, the asset digests, the count, the dimension, the dtype,
    # the vectors digest, the artifact digest, the device, the runtime
    # versions, the timestamp, the latency, the peak memory, the license
    # and the calibration status.
    embedder = _embedder(tmp_path)

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))
    payload = json.loads(
        (result.artifact_path / "manifest.json").read_text(encoding="utf8")
    )

    for field in (
        "schemaVersion",
        "embeddingRunId",
        "modelId",
        "revision",
        "sourceUri",
        "weightsDigest",
        "preprocessingFingerprint",
        "preprocessingComponents",
        "snapshotId",
        "assetSha256",
        "count",
        "dimension",
        "dtype",
        "vectorsFileDigest",
        "artifactDigest",
        "device",
        "runtimeVersions",
        "createdAt",
        "latency",
        "peakMemoryBytes",
        "license",
        "calibrationStatus",
    ):
        assert field in payload, field
    assert payload["schemaVersion"] == MANIFEST_SCHEMA_VERSION
    assert payload["license"] == "apache-2.0"
    assert payload["calibrationStatus"] == "uncalibrated"
    assert len(payload["assetSha256"]) == payload["count"]
    assert payload["vectorsFileDigest"]
    assert payload["artifactDigest"]


def test_a_value_that_does_not_exist_reads_unknown_and_not_zero(tmp_path: Path):
    # FR-012: a measurement that was never taken is `unknown`.
    embedder = _embedder(tmp_path)

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=()))
    payload = json.loads(
        (result.artifact_path / "manifest.json").read_text(encoding="utf8")
    )

    assert payload["latency"]["p50Ms"] == UNKNOWN
    assert payload["latency"]["totalMs"] == UNKNOWN
    assert payload["count"] == 0


def test_a_corrupt_image_is_an_error_sample_and_the_others_still_embed(tmp_path: Path):
    # Task 4.1: the error names the file, the other images still embed,
    # and the error appears in the error sample list.
    root = tmp_path / "images"
    root.mkdir()
    original = sorted(FIXTURES_DIR.glob("*.jpg"))[0]
    good = root / original.name
    good.write_bytes(original.read_bytes())
    broken = root / "broken.jpg"
    broken.write_bytes(b"\xff\xd8\xff\xe0 not really a jpeg")
    embedder = VisionEmbedder(
        record=_record(),
        encoder=_StubEncoder(),
        spec=_spec(),
        decoder=DecodeService(root),
        device=DevicePlanner({"cpu": True}).plan("cpu"),
        artifact_root=tmp_path / "artifacts-root",
    )

    result = embedder.embed(
        EmbedRequest(
            snapshot_id="snapshot-test",
            assets=(
                EmbedAsset(asset_id="broken.jpg", path=broken),
                EmbedAsset(asset_id=good.name, path=good),
            ),
        )
    )

    assert result.count == 1
    assert len(result.errors) == 1
    error = result.errors[0]
    assert error.asset_id == "broken.jpg"
    assert "broken.jpg" in error.path
    assert error.code == "IMAGE_METADATA_UNREADABLE"
    assert error.message


def test_a_batch_that_exhausts_the_memory_reduces_and_records_the_fallback(
    tmp_path: Path,
):
    # Task 2.9: the batch is reduced a bounded number of times, and the
    # event names the old and the new batch size.
    class _Hungry:
        model_id = "stub"
        revision = "stub-revision"
        dimension = 4
        dtype = "float32"

        def __init__(self) -> None:
            self.sizes: list[int] = []

        def embed(self, images: Sequence[Any]) -> EncoderOutput:
            self.sizes.append(len(images))
            if len(images) > 1:
                raise RuntimeError("DefaultCPUAllocator: not enough memory")
            return EncoderOutput(
                vectors=tuple(tuple(0.0 for _ in range(4)) for _ in images),
                dimension=4,
                dtype="float32",
            )

    encoder = _Hungry()
    embedder = VisionEmbedder(
        record=_record(),
        encoder=encoder,
        spec=_spec(),
        decoder=DecodeService(FIXTURES_DIR),
        device=DevicePlanner({"cpu": True}).plan("cpu"),
        artifact_root=tmp_path / "artifacts-root",
        scheduler=BatchScheduler(max_batch_size=8, min_batch_size=1, max_attempts=3),
    )

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    assert result.count == len(_assets())
    assert result.fallbacks
    first = result.fallbacks[0]
    assert first.old_batch_size == len(_assets())
    assert first.new_batch_size == len(_assets()) // 2
    assert first.reason


def test_a_batch_that_never_fits_is_a_typed_failure(tmp_path: Path):
    class _NeverFits:
        model_id = "stub"
        revision = "stub-revision"
        dimension = 4
        dtype = "float32"

        def embed(self, images: Sequence[Any]) -> EncoderOutput:
            raise RuntimeError("DefaultCPUAllocator: not enough memory")

    embedder = VisionEmbedder(
        record=_record(),
        encoder=_NeverFits(),
        spec=_spec(),
        decoder=DecodeService(FIXTURES_DIR),
        device=DevicePlanner({"cpu": True}).plan("cpu"),
        artifact_root=tmp_path / "artifacts-root",
        scheduler=BatchScheduler(max_batch_size=8, min_batch_size=1, max_attempts=2),
    )

    with pytest.raises(Exception) as excinfo:
        embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    assert "memory" in str(excinfo.value)


def test_the_artifact_reader_refuses_a_vectors_file_that_was_tampered_with(tmp_path: Path):
    # The reader verifies: a vectors file that does not carry the digest
    # the manifest names is not the artifact of that manifest.
    embedder = _embedder(tmp_path)

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))
    vectors = result.artifact_path / "vectors.f32"
    payload = bytearray(vectors.read_bytes())
    payload[0] = (payload[0] + 1) % 256
    vectors.write_bytes(bytes(payload))

    with pytest.raises(ValueError) as excinfo:
        read_embedding_artifact(result.artifact_path)

    assert "vectors file" in str(excinfo.value)


def test_the_artifact_address_is_the_address_of_its_content(tmp_path: Path):
    # Two runs of the same content share the address: the run id, the
    # timestamp and the latency describe the run and not the content.
    embedder = _embedder(tmp_path)

    first = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))
    second = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    assert first.artifact_sha256 == second.artifact_sha256
    assert first.run_id != second.run_id


def test_the_manifest_round_trips_through_its_own_reader(tmp_path: Path):
    embedder = _embedder(tmp_path)

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))
    artifact = read_embedding_artifact(result.artifact_path)

    assert artifact.manifest.count == result.count
    assert artifact.manifest.model_id == "siglip2-base"
    assert artifact.manifest.preprocessing_fingerprint == _spec().fingerprint()


def test_the_manifest_refuses_a_mapping_without_its_fields():
    with pytest.raises(ValueError) as excinfo:
        manifest_from_dict({"modelId": "siglip2-base"})

    assert "embeddingRunId" in str(excinfo.value)


def test_the_decoder_refuses_a_corrupt_image_before_the_run(tmp_path: Path):
    root = tmp_path / "images"
    root.mkdir()
    broken = root / "broken.jpg"
    broken.write_bytes(b"\xff\xd8\xff\xe0 not really a jpeg")
    service = DecodeService(root)

    with pytest.raises(ImageMetadataUnreadableError):
        service.decode(broken)


def test_an_image_the_preprocessing_refuses_is_an_error_sample(tmp_path: Path):
    # The preprocessing can refuse the pixels of an image that decoded
    # fine. The image is an error sample and the other images still embed:
    # a broken file never takes the run down with it.
    class _BrokenSpec(PreprocessingSpec):
        def apply(self, image: Any) -> Any:
            raise ValueError("the normalization of this platform has three channels")

    embedder = VisionEmbedder(
        record=_record(),
        encoder=_StubEncoder(),
        spec=_BrokenSpec(
            height=8,
            width=8,
            interpolation="bilinear",
            rescale_factor=1.0 / 255.0,
            mean=(0.5, 0.5, 0.5),
            std=(0.5, 0.5, 0.5),
        ),
        decoder=DecodeService(FIXTURES_DIR),
        device=DevicePlanner({"cpu": True}).plan("cpu"),
        artifact_root=tmp_path / "artifacts-root",
        snapshot_id="snapshot-test",
    )

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    assert len(result.errors) == len(_assets())
    assert result.count == 0
    assert result.errors[0].code == "IMAGE_METADATA_UNREADABLE"
    assert "three channels" in result.errors[0].message


def test_a_typed_failure_of_the_library_keeps_its_own_code(tmp_path: Path):
    # A missing extra is not a model that refused the batch: the code the
    # caller acts on is the code the failure carries.
    from visionlens.errors import MissingExtraError

    class _MissingEncoder:
        model_id = "stub"
        revision = "stub-revision"
        dimension = 4
        dtype = "float32"

        def embed(self, images: Sequence[Any]) -> EncoderOutput:
            raise MissingExtraError("the 'vision' extra is not installed")

    embedder = _embedder(tmp_path, encoder=_MissingEncoder())

    with pytest.raises(MissingExtraError) as excinfo:
        embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    assert excinfo.value.code.value == "EXTRA_NOT_INSTALLED"


def test_the_reader_refuses_a_manifest_without_an_artifact_digest(tmp_path: Path):
    # The digest is what makes the artifact addressable, so a manifest
    # without one is not an artifact this package wrote.
    embedder = _embedder(tmp_path)

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    manifest_path = result.artifact_path / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf8"))
    del payload["artifactDigest"]
    manifest_path.write_text(json.dumps(payload), encoding="utf8")

    with pytest.raises(ValueError) as excinfo:
        read_embedding_artifact(result.artifact_path)

    assert "artifactDigest" in str(excinfo.value)


def test_the_reader_refuses_a_manifest_with_an_empty_artifact_digest(tmp_path: Path):
    embedder = _embedder(tmp_path)

    result = embedder.embed(EmbedRequest(snapshot_id="snapshot-test", assets=_assets()))

    manifest_path = result.artifact_path / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf8"))
    payload["artifactDigest"] = ""
    manifest_path.write_text(json.dumps(payload), encoding="utf8")

    with pytest.raises(ValueError) as excinfo:
        read_embedding_artifact(result.artifact_path)

    assert "artifact digest" in str(excinfo.value)
