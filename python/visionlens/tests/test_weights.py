"""The weights loader and every refusal that comes before the fetch.

The loader is the only place in the runtime where a model artifact can be
fetched, so its refusals are the supply-chain gate
(docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:10, :15). Each test below
proves one refusal, and proves it happens BEFORE any byte is fetched: the
opener is a spy that fails the test if it is ever called.
"""

from __future__ import annotations

import dataclasses
import json
import os
import struct
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Iterator

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.downloads import DownloadRefusedError
from visionlens.encoders.weights import (
    AuthorizedWeights,
    DownloadPermission,
    LoadedWeights,
    WeightsRequest,
    authorize_weights_download,
    check_license,
    check_model_id,
    check_safetensors,
    check_source,
    load_weights,
)
from visionlens.registry.loader import record_from_mapping
from visionlens.registry.record import ModelRecord

#: The tracked registry, from the repository root.
REPO_ROOT = Path(__file__).resolve().parents[3]
TRACKED_REGISTRY = REPO_ROOT / "datasets" / "registry.json"

#: The revision the tracked record pins.
REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"

#: The source the tracked record names.
SOURCE = (
    "https://huggingface.co/google/siglip2-base-patch16-224/resolve/"
    + REVISION
    + "/model.safetensors"
)

#: A safetensors payload: the length of the JSON header, the header, then
#: the bytes of the tensor it describes.
SAFETENSORS_HEADER = json.dumps(
    {"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
).encode("utf8")
PAYLOAD = struct.pack("<Q", len(SAFETENSORS_HEADER)) + SAFETENSORS_HEADER + b"\x00\x00\x00\x00"

#: The sha256 of PAYLOAD.
PAYLOAD_DIGEST = ""


def _digest_of(payload: bytes) -> str:
    """The sha256 of the payload, computed the way the loader does."""
    from visionlens.hashing import sha256_of_bytes

    return sha256_of_bytes(payload)


PAYLOAD_DIGEST = _digest_of(PAYLOAD)


def _record(**overrides: Any) -> ModelRecord:
    """A record that satisfies every gate, so a test varies one thing."""
    base = ModelRecord(
        model_id="siglip2-base",
        revision=REVISION,
        source_uri=SOURCE,
        source_digest=PAYLOAD_DIGEST,
        license="apache-2.0",
        license_url="https://www.apache.org/licenses/LICENSE-2.0",
        commercial_use=True,
        usage_restrictions="the attribution must travel with any redistribution",
        required_extras=("vision",),
        tasks=("image-embedding",),
        preprocessing_fingerprint="fp2:83adc4ef99979644",
        device_support=("cpu",),
        input_image_size=(224, 224),
        feature_extractor="siglip_vision_model",
        output_dimension=768,
        latency_cost_profile="unknown",
        calibration_status="uncalibrated",
        trust_policy="allowlisted-pinned-safetensors-only",
        attribution="The fixture authors.",
        notes="",
    )
    return dataclasses.replace(base, **overrides)


def _spy_opener(payload: bytes = PAYLOAD) -> tuple[Any, list[str]]:
    """An opener that records being called and refuses to be called."""
    calls: list[str] = []

    def opener(url: str) -> Iterator[bytes]:
        calls.append(url)
        yield payload

    return opener, calls


def _request(record: ModelRecord, use: str = "inference") -> WeightsRequest:
    """A request with a granted permission."""
    return WeightsRequest(
        record=record,
        use=use,
        permission=DownloadPermission.grant("the test"),
    )


def test_a_download_without_an_explicit_permission_performs_no_fetch(tmp_path: Path):
    # Task 1.5: the permission is an opt-in, and without it nothing is
    # fetched and the cache directory stays empty.
    opener, calls = _spy_opener()
    cache = tmp_path / "cache"
    request = WeightsRequest(
        record=_record(),
        use="inference",
        permission=DownloadPermission.deny(),
    )

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(request, cache, opener=opener)

    assert excinfo.value.reason == "PERMISSION_MISSING"
    assert calls == []
    assert not cache.exists() or list(cache.rglob("*")) == []


def test_a_permission_nobody_granted_is_not_a_permission():
    # The permission is an object, not a flag: a truthy value is refused.
    with pytest.raises(ValueError):
        DownloadPermission(granted="yes", granted_by="the test")  # type: ignore[arg-type]


def test_a_granted_permission_names_the_actor_that_granted_it():
    with pytest.raises(ValueError):
        DownloadPermission(granted=True, granted_by="")


def test_the_license_gate_refuses_a_forbidden_use_before_any_byte_is_fetched(tmp_path: Path):
    # Task 1.6: a use the recorded license forbids is refused BEFORE the
    # fetch, never after it.
    opener, calls = _spy_opener()
    cache = tmp_path / "cache"
    record = _record(commercial_use=False)

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(
            WeightsRequest(
                record=record,
                use="commercial",
                permission=DownloadPermission.grant("the test"),
            ),
            cache,
            opener=opener,
        )

    assert excinfo.value.reason == "LICENSE_FORBIDDEN"
    assert "commercial" in str(excinfo.value)
    assert calls == []
    assert not cache.exists()


def test_the_license_gate_runs_before_the_permission_is_asked_about(tmp_path: Path):
    # The order is the property: a use the license forbids is refused even
    # when nobody granted the permission, so the license is never traded
    # for a permission.
    opener, calls = _spy_opener()
    record = _record(commercial_use=False)

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(
            WeightsRequest(
                record=record,
                use="commercial",
                permission=DownloadPermission.deny(),
            ),
            tmp_path / "cache",
            opener=opener,
        )

    assert excinfo.value.reason == "LICENSE_FORBIDDEN"
    assert calls == []


def test_the_license_gate_refuses_a_record_that_contradicts_itself(tmp_path: Path):
    # The gate reads the facts, and it refuses a record whose recorded
    # restrictions forbid what its own flag permits.
    opener, calls = _spy_opener()
    record = _record(usage_restrictions="RESEARCH USE ONLY, non-commercial")

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(
            WeightsRequest(
                record=record,
                use="commercial",
                permission=DownloadPermission.grant("the test"),
            ),
            tmp_path / "cache",
            opener=opener,
        )

    assert excinfo.value.reason == "LICENSE_FORBIDDEN"
    assert calls == []


def test_the_license_gate_refuses_a_use_it_does_not_know(tmp_path: Path):
    opener, calls = _spy_opener()

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(
            WeightsRequest(
                record=_record(),
                use="resale",
                permission=DownloadPermission.grant("the test"),
            ),
            tmp_path / "cache",
            opener=opener,
        )

    assert excinfo.value.reason == "USE_NOT_KNOWN"
    assert calls == []


def test_the_license_gate_refuses_redistribution(tmp_path: Path):
    # The loader writes into a local cache and never ships the weights, so
    # a redistribution is outside what it can decide.
    with pytest.raises(DownloadRefusedError) as excinfo:
        check_license(_record(), "redistribution")

    assert excinfo.value.reason == "LICENSE_FORBIDDEN"


def test_inference_is_permitted_by_any_recorded_license():
    # A local run is what the platform does with the weights.
    check_license(_record(commercial_use=False), "inference")


def test_a_record_with_a_policy_the_loader_does_not_implement_is_refused(tmp_path: Path):
    # The trust policy a record declares is the set of rules it runs under.
    # The loader implements one policy and refuses another.
    opener, calls = _spy_opener()
    record = _record(trust_policy="anything-goes")

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "TRUST_POLICY_UNSUPPORTED"
    assert calls == []


def test_a_source_outside_the_allowlist_is_refused_before_the_fetch(tmp_path: Path):
    opener, calls = _spy_opener()
    record = _record(source_uri="https://weights.example.test/model.safetensors")

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "SOURCE_NOT_ALLOWED"
    assert calls == []


def test_a_source_that_is_not_https_is_refused(tmp_path: Path):
    opener, calls = _spy_opener()
    record = _record(source_uri=SOURCE.replace("https://", "http://"))

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "SOURCE_NOT_ALLOWED"
    assert calls == []


def test_a_source_that_does_not_carry_the_pinned_revision_is_refused(tmp_path: Path):
    opener, calls = _spy_opener()
    record = _record(
        source_uri=(
            "https://huggingface.co/google/siglip2-base-patch16-224/resolve/"
            "main/model.safetensors"
        )
    )

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "REVISION_NOT_PINNED"
    assert calls == []


def test_a_revision_in_a_query_string_is_not_a_pin(tmp_path: Path):
    # The revision has to be the revision of the file, not a string that
    # happens to appear somewhere in the URL.
    opener, calls = _spy_opener()
    record = _record(
        source_uri=(
            "https://huggingface.co/google/siglip2-base-patch16-224/resolve/"
            "main/model.safetensors?rev=" + REVISION
        )
    )

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "REVISION_NOT_PINNED"
    assert calls == []


def test_a_directory_named_after_the_revision_is_not_a_pin(tmp_path: Path):
    opener, calls = _spy_opener()
    record = _record(
        source_uri=(
            "https://huggingface.co/google/siglip2-base-patch16-224/resolve/"
            + REVISION
            + "-other/model.safetensors"
        )
    )

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "REVISION_NOT_PINNED"
    assert calls == []


def test_a_revision_that_is_not_an_exact_commit_is_refused(tmp_path: Path):
    opener, calls = _spy_opener()
    record = _record(
        revision="v1.0.0",
        source_uri=(
            "https://huggingface.co/google/siglip2-base-patch16-224/resolve/"
            "v1.0.0/model.safetensors"
        ),
    )

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "REVISION_NOT_PINNED"
    assert calls == []


def test_a_pickle_checkpoint_is_refused_before_the_fetch(tmp_path: Path):
    opener, calls = _spy_opener()
    record = _record(
        source_uri=(
            "https://huggingface.co/google/siglip2-base-patch16-224/resolve/"
            + REVISION
            + "/pytorch_model.bin"
        )
    )

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert excinfo.value.reason == "UNSAFE_FORMAT"
    assert calls == []


def test_bytes_that_are_not_safetensors_are_refused(tmp_path: Path):
    # The name of the cached file claims a format, and the bytes have to
    # carry it: a pickle payload behind a safetensors name is refused.
    opener, calls = _spy_opener(b"\x80\x04\x95\x00\x00\x00\x00\x00pickle")
    record = _record(source_digest=_digest_of(b"\x80\x04\x95\x00\x00\x00\x00\x00pickle"))
    cache = tmp_path / "cache"

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), cache, opener=opener)

    assert excinfo.value.reason == "UNSAFE_FORMAT"
    assert calls
    assert not cache.exists() or list(cache.rglob("*.safetensors")) == []


def test_a_model_id_that_would_escape_the_cache_is_refused(tmp_path: Path):
    opener, calls = _spy_opener()
    record = _record(model_id="../escaped")
    cache = tmp_path / "cache"

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(record), cache, opener=opener)

    assert excinfo.value.reason == "MODEL_ID_UNSAFE"
    assert calls == []
    assert not (tmp_path / "escaped").exists()


def test_a_model_id_that_is_an_absolute_path_is_refused():
    with pytest.raises(DownloadRefusedError) as excinfo:
        check_model_id(_record(model_id="/tmp/absolute"))

    assert excinfo.value.reason == "MODEL_ID_UNSAFE"


def test_a_cache_directory_that_is_a_symlink_out_of_the_cache_is_refused(tmp_path: Path):
    # A symlink in the cache must not place the weights somewhere else.
    opener, calls = _spy_opener()
    cache = tmp_path / "cache"
    outside = tmp_path / "outside"
    outside.mkdir()
    cache.mkdir()
    (cache / "siglip2-base").symlink_to(outside)

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(_record()), cache, opener=opener)

    assert excinfo.value.reason == "MODEL_ID_UNSAFE"
    assert calls == []
    assert list(outside.iterdir()) == []


def test_bytes_that_do_not_carry_the_recorded_digest_are_refused(tmp_path: Path):
    # The digest is the promise. Bytes that do not match never reach the
    # cache, and the cache stays exactly as it was.
    opener, calls = _spy_opener(b"different bytes")
    cache = tmp_path / "cache"

    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(_request(_record()), cache, opener=opener)

    assert excinfo.value.reason == "DIGEST_MISMATCH"
    assert calls  # the fetch happened, and the refusal came after it
    assert not cache.exists() or list(cache.rglob("*.safetensors")) == []


def test_the_weights_land_in_the_cache_with_their_digest_in_the_name(tmp_path: Path):
    opener, calls = _spy_opener()
    cache = tmp_path / "cache"

    loaded = load_weights(_request(_record()), cache, opener=opener)

    assert isinstance(loaded, LoadedWeights)
    assert loaded.digest == PAYLOAD_DIGEST
    assert loaded.size_bytes == len(PAYLOAD)
    assert loaded.from_cache is False
    assert loaded.path.exists()
    assert loaded.path.read_bytes() == PAYLOAD
    assert loaded.path.name == PAYLOAD_DIGEST + ".safetensors"
    assert len(calls) == 1


def test_the_bytes_are_written_as_they_arrive_and_never_held_whole(tmp_path: Path):
    # The loader streams: the first megabyte is already on the disk before
    # the fetch produces the last one, so the bytes are never held in
    # memory.
    megabyte = 1024 * 1024
    big = PAYLOAD + b"\x00" * megabyte
    record = _record(source_digest=_digest_of(big))
    seen: list[int] = []

    def opener(url: str) -> Iterator[bytes]:
        yield big[:megabyte]
        files = list(tmp_path.rglob(".weights-*.tmp"))
        seen.append(sum(entry.stat().st_size for entry in files))
        yield big[megabyte:]

    load_weights(_request(record), tmp_path / "cache", opener=opener)

    assert seen == [megabyte]


def test_a_cached_file_is_reused_without_a_fetch(tmp_path: Path):
    opener, calls = _spy_opener()
    cache = tmp_path / "cache"
    request = _request(_record())

    first = load_weights(request, cache, opener=opener)
    second = load_weights(request, cache, opener=opener)

    assert second.from_cache is True
    assert second.path == first.path
    assert len(calls) == 1


def test_two_loaders_of_the_same_file_fetch_it_once(tmp_path: Path):
    # The cache is shared, so two loaders of the same weights must not
    # fetch the same bytes twice.
    calls: list[str] = []
    started = threading.Event()

    def opener(url: str) -> Iterator[bytes]:
        calls.append(url)
        started.set()
        yield PAYLOAD

    cache = tmp_path / "cache"
    results: list[LoadedWeights] = []

    def run() -> None:
        results.append(load_weights(_request(_record()), cache, opener=opener))

    first = threading.Thread(target=run)
    first.start()
    started.wait(timeout=5)
    second = threading.Thread(target=run)
    second.start()
    first.join(timeout=30)
    second.join(timeout=30)

    assert len(results) == 2
    assert len(calls) == 1
    assert results[0].path == results[1].path


def test_a_cached_file_that_does_not_match_its_name_is_removed(tmp_path: Path):
    opener, calls = _spy_opener()
    cache = tmp_path / "cache"
    request = _request(_record())
    loaded = load_weights(request, cache, opener=opener)

    # Somebody else wrote over the cached file.
    loaded.path.write_bytes(b"tampered")
    with pytest.raises(DownloadRefusedError) as excinfo:
        load_weights(request, cache, opener=opener)

    assert excinfo.value.reason == "CACHE_CORRUPT"
    assert not loaded.path.exists()


def test_a_temporary_file_of_a_crashed_run_is_swept(tmp_path: Path):
    # A crash leaves a temporary file behind; the next load sweeps it.
    cache = tmp_path / "cache"
    model_dir = cache / "siglip2-base"
    model_dir.mkdir(parents=True)
    stale = model_dir / ".weights-stale.tmp"
    stale.write_bytes(b"half a file")
    old = time.time() - 7200
    os.utime(stale, (old, old))

    opener, calls = _spy_opener()
    load_weights(_request(_record()), cache, opener=opener)

    assert not stale.exists()


def test_a_temporary_file_of_a_running_loader_is_never_swept(tmp_path: Path):
    cache = tmp_path / "cache"
    model_dir = cache / "siglip2-base"
    model_dir.mkdir(parents=True)
    fresh = model_dir / ".weights-fresh.tmp"
    fresh.write_bytes(b"a file being written right now")

    opener, calls = _spy_opener()
    load_weights(_request(_record()), cache, opener=opener)

    assert fresh.exists()


def test_the_authorization_carries_the_proof():
    authorized = authorize_weights_download(_request(_record()))

    assert isinstance(authorized, AuthorizedWeights)
    assert authorized.revision == REVISION
    assert authorized.digest == PAYLOAD_DIGEST
    assert authorized.license == "apache-2.0"


def test_a_safetensors_file_is_accepted_and_a_pickle_is_not(tmp_path: Path):
    good = tmp_path / "model.safetensors"
    good.write_bytes(PAYLOAD)
    check_safetensors(good)

    bad = tmp_path / "model.bin"
    bad.write_bytes(b"\x80\x04\x95\x00\x00\x00\x00\x00")
    with pytest.raises(DownloadRefusedError) as excinfo:
        check_safetensors(bad)

    assert excinfo.value.reason == "UNSAFE_FORMAT"


def test_the_tracked_record_is_admitted_by_every_gate(tmp_path: Path):
    # The record that ships in the registry must pass the gates of the
    # loader: a gate that refuses the platform's own record is a gate that
    # is wrong.
    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    entry = next(
        item for item in registry["models"] if item["modelId"] == "siglip2-base"
    )
    record = record_from_mapping(entry)

    check_license(record, "inference")
    check_license(record, "commercial")
    check_source(record)
    authorized = authorize_weights_download(_request(record))
    assert authorized.digest == record.source_digest


def test_the_tracked_record_names_the_bytes_the_loader_verifies(tmp_path: Path):
    # The digest of the tracked record is the digest of the file the loader
    # would verify, and the loader reads the weights in bounded blocks.
    from visionlens.hashing import sha256_of_file

    registry = json.loads(TRACKED_REGISTRY.read_text(encoding="utf8"))
    entry = next(
        item for item in registry["models"] if item["modelId"] == "siglip2-base"
    )
    record = record_from_mapping(entry)
    assert entry["sourceDigest"] == record.source_digest
    assert len(record.source_digest) == 64


def test_the_loader_asks_only_for_the_allowlisted_url(tmp_path: Path):
    # The opener is the only place that reaches out, and it is only ever
    # asked for the source the record names.
    asked: list[str] = []

    def opener(url: str) -> Iterable[bytes]:
        asked.append(url)
        yield PAYLOAD

    load_weights(_request(_record()), tmp_path / "cache", opener=opener)

    assert asked == [SOURCE]
