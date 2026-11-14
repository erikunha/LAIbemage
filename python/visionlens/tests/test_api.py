"""The typed facade: config, capabilities and dataset inspection (spec 017, US3).

Red-first: every test in this file fails before the facade exists. The
properties under test are the ones the ticket names: a versioned, round-tripping
config, a serializable capability record, an image metadata operation that
needs no Node and no network, and typed failures that carry a stable code and
no raw traceback text.
"""

from __future__ import annotations

import hashlib
import json
import struct
import zlib
from pathlib import Path

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens import (
    CONFIG_SCHEMA_VERSION,
    EXTRA_NAMES,
    Capabilities,
    DatasetInspection,
    LocalConfig,
    VisionLens,
)
from visionlens.data import inspect as inspect_module
from visionlens.errors import (
    ClientClosedError,
    ConfigVersionUnsupportedError,
    ErrorCode,
    ImageDimensionsExceededError,
    ImageMetadataUnreadableError,
    LibraryError,
    LibraryErrorCode,
    MimeMismatchError,
    PathNotFoundError,
    UnsupportedFileTypeError,
)


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def png_bytes(width: int, height: int) -> bytes:
    """A real PNG of the given dimensions, built with the standard library."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x00" * (width * 3) for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(raw))
        + _png_chunk(b"IEND", b"")
    )


def png_header_bytes(width: int, height: int) -> bytes:
    """A PNG header alone: the dimensions are declared, the pixels are not."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr)


def jpeg_bytes(width: int, height: int) -> bytes:
    """A JPEG carrying a start-of-frame segment with the given dimensions."""
    frame = b"\x08" + struct.pack(">HH", height, width) + b"\x01\x11\x00"
    segment = b"\xff\xc0" + struct.pack(">H", len(frame) + 2) + frame
    return b"\xff\xd8" + segment + b"\xff\xd9"


def jpeg_with_large_metadata_bytes(width: int, height: int, metadata_bytes: int) -> bytes:
    """A JPEG whose EXIF segments are large and come before the frame header.

    A JPEG segment carries a two-byte length, so a large metadata block is
    several segments: the frame header then sits far past any fixed window a
    reader might read.
    """
    segments = b""
    remaining = metadata_bytes
    while remaining > 0:
        size = min(remaining, 60_000)
        payload = b"Exif\x00\x00" + b"\x00" * (size - 6)
        segments += b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
        remaining -= size
    frame = b"\x08" + struct.pack(">HH", height, width) + b"\x01\x11\x00"
    sof = b"\xff\xc0" + struct.pack(">H", len(frame) + 2) + frame
    return b"\xff\xd8" + segments + sof + b"\xff\xd9"


def gif_bytes(width: int, height: int) -> bytes:
    """A GIF header with the given dimensions."""
    return b"GIF89a" + struct.pack("<HH", width, height) + b"\x00\x00\x00"


def webp_bytes(fourcc: bytes, payload: bytes) -> bytes:
    """A RIFF/WEBP container carrying one chunk."""
    return (
        b"RIFF"
        + struct.pack("<I", 4 + 8 + len(payload))
        + b"WEBP"
        + fourcc
        + struct.pack("<I", len(payload))
        + payload
    )


def webp_vp8_bytes(width: int, height: int) -> bytes:
    """A lossy WebP, whose frame header carries the dimensions."""
    payload = b"\x00\x00\x00\x9d\x01\x2a" + struct.pack("<HH", width, height)
    return webp_bytes(b"VP8 ", payload)


def webp_vp8l_bytes(width: int, height: int) -> bytes:
    """A lossless WebP, whose header carries the dimensions."""
    bits = (width - 1) | ((height - 1) << 14)
    return webp_bytes(b"VP8L", b"\x2f" + struct.pack("<I", bits))


def webp_vp8x_bytes(width: int, height: int) -> bytes:
    """An extended WebP, whose header carries the canvas size."""
    payload = (
        b"\x10\x00\x00\x00"
        + (width - 1).to_bytes(3, "little")
        + (height - 1).to_bytes(3, "little")
    )
    return webp_bytes(b"VP8X", payload)


# --- the configuration -------------------------------------------------------


def test_config_round_trips_through_plain_json():
    config = LocalConfig(device="auto")

    raw = config.to_json()

    assert json.loads(raw) == {
        "schema_version": CONFIG_SCHEMA_VERSION,
        "device": "auto",
        "cache_dir": None,
    }
    assert LocalConfig.from_json(raw) == config


def test_config_exposes_the_schema_version():
    config = LocalConfig()

    assert config.schema_version == CONFIG_SCHEMA_VERSION
    assert json.loads(config.to_json())["schema_version"] == CONFIG_SCHEMA_VERSION


def test_config_refuses_an_unknown_schema_version():
    with pytest.raises(ConfigVersionUnsupportedError) as caught:
        LocalConfig.from_json(json.dumps({"schema_version": CONFIG_SCHEMA_VERSION + 1}))

    assert caught.value.code.value == "CONFIG_VERSION_UNSUPPORTED"


def test_config_refuses_a_schema_version_that_is_not_an_integer():
    for payload in ({"schema_version": True}, {"schema_version": 1.0}, {"schema_version": "1"}):
        with pytest.raises(ConfigVersionUnsupportedError):
            LocalConfig.from_json(json.dumps(payload))


def test_config_refuses_an_unknown_device():
    with pytest.raises(LibraryError):
        LocalConfig(device="mps")


# --- the capability record ---------------------------------------------------


def test_capabilities_are_serializable_and_name_the_device_extras_and_version():
    with VisionLens.local(LocalConfig(device="auto")) as client:
        capabilities = client.capabilities()

    assert isinstance(capabilities, Capabilities)
    assert capabilities.device == "cpu"
    assert capabilities.device_reason
    assert capabilities.version == "0.1.0"

    payload = json.loads(capabilities.model_dump_json())
    assert payload["device"] == "cpu"
    assert payload["version"] == "0.1.0"
    assert {extra["name"] for extra in payload["extras"]} == {
        "vision",
        "training",
        "agents",
        "server",
        "all",
    }


def test_capabilities_report_the_heavy_extras_as_unavailable_in_a_base_install():
    with VisionLens.local() as client:
        capabilities = client.capabilities()

    vision = next(extra for extra in capabilities.extras if extra.name == "vision")
    assert vision.available is False
    assert vision.missing_modules
    assert capabilities.installed_extras == ()


# --- the image metadata operation ---------------------------------------------


def test_inspect_returns_the_image_metadata(tmp_path: Path):
    image = tmp_path / "sample.png"
    payload = png_bytes(4, 3)
    image.write_bytes(payload)

    with VisionLens.local() as client:
        inspection = client.datasets.inspect(image)

    assert isinstance(inspection, DatasetInspection)
    assert inspection.width == 4
    assert inspection.height == 3
    assert inspection.mime_type == "image/png"
    assert inspection.sha256 == hashlib.sha256(payload).hexdigest()


def test_inspect_reads_a_jpeg_dimensions(tmp_path: Path):
    image = tmp_path / "sample.jpg"
    image.write_bytes(jpeg_bytes(7, 5))

    with VisionLens.local() as client:
        inspection = client.datasets.inspect(image)

    assert (inspection.width, inspection.height) == (7, 5)
    assert inspection.mime_type == "image/jpeg"


def test_inspect_reads_a_jpeg_that_carries_a_large_metadata_segment(tmp_path: Path):
    image = tmp_path / "with-exif.jpg"
    image.write_bytes(jpeg_with_large_metadata_bytes(9, 6, 200_000))

    with VisionLens.local() as client:
        inspection = client.datasets.inspect(image)

    assert (inspection.width, inspection.height) == (9, 6)
    assert inspection.mime_type == "image/jpeg"


def test_inspect_reads_a_gif_dimensions(tmp_path: Path):
    image = tmp_path / "sample.gif"
    image.write_bytes(gif_bytes(11, 13))

    with VisionLens.local() as client:
        inspection = client.datasets.inspect(image)

    assert (inspection.width, inspection.height) == (11, 13)
    assert inspection.mime_type == "image/gif"


def test_inspect_reads_every_webp_variant(tmp_path: Path):
    variants = {
        "lossy.webp": webp_vp8_bytes(21, 22),
        "lossless.webp": webp_vp8l_bytes(23, 24),
        "extended.webp": webp_vp8x_bytes(25, 26),
    }

    with VisionLens.local() as client:
        for name, payload in variants.items():
            image = tmp_path / name
            image.write_bytes(payload)
            inspection = client.datasets.inspect(image)
            assert inspection.mime_type == "image/webp", name
            assert inspection.width > 0 and inspection.height > 0, name


def test_inspect_refuses_a_missing_path(tmp_path: Path):
    with VisionLens.local() as client:
        with pytest.raises(PathNotFoundError) as caught:
            client.datasets.inspect(tmp_path / "absent.png")

    assert caught.value.code.value == "PATH_NOT_FOUND"
    assert "Traceback" not in str(caught.value)


def test_inspect_refuses_a_directory(tmp_path: Path):
    with VisionLens.local() as client:
        with pytest.raises(PathNotFoundError):
            client.datasets.inspect(tmp_path)


def test_inspect_refuses_an_unsupported_file_type(tmp_path: Path):
    document = tmp_path / "notes.txt"
    document.write_text("not an image", encoding="utf-8")

    with VisionLens.local() as client:
        with pytest.raises(UnsupportedFileTypeError) as caught:
            client.datasets.inspect(document)

    assert caught.value.code.value == "UNSUPPORTED_FILE_TYPE"
    assert "Traceback" not in str(caught.value)


def test_inspect_refuses_an_extension_that_contradicts_the_magic_bytes(tmp_path: Path):
    image = tmp_path / "actually-a-png.jpg"
    image.write_bytes(png_bytes(2, 2))

    with VisionLens.local() as client:
        with pytest.raises(MimeMismatchError) as caught:
            client.datasets.inspect(image)

    assert caught.value.code.value == "MIME_MISMATCH"


def test_inspect_refuses_dimensions_over_the_cap(tmp_path: Path):
    image = tmp_path / "bomb.png"
    image.write_bytes(png_header_bytes(100_000, 100_000))

    with VisionLens.local() as client:
        with pytest.raises(ImageDimensionsExceededError) as caught:
            client.datasets.inspect(image)

    assert caught.value.code.value == "IMAGE_DIMENSIONS_EXCEEDED"


def test_inspect_refuses_an_image_whose_metadata_cannot_be_read(tmp_path: Path):
    image = tmp_path / "truncated.jpg"
    image.write_bytes(b"\xff\xd8")

    with VisionLens.local() as client:
        with pytest.raises(ImageMetadataUnreadableError) as caught:
            client.datasets.inspect(image)

    assert caught.value.code.value == "IMAGE_METADATA_UNREADABLE"


def test_the_dimension_cap_runs_before_the_file_is_digested(monkeypatch, tmp_path: Path):
    image = tmp_path / "bomb.png"
    image.write_bytes(png_header_bytes(100_000, 100_000))

    def fail(*args, **kwargs):
        raise AssertionError("the digest must not run before the dimension cap")

    monkeypatch.setattr(inspect_module, "sha256_of_file", fail)

    with VisionLens.local() as client:
        with pytest.raises(ImageDimensionsExceededError):
            client.datasets.inspect(image)


def test_the_mime_check_runs_before_the_file_is_digested(monkeypatch, tmp_path: Path):
    image = tmp_path / "actually-a-png.jpg"
    image.write_bytes(png_bytes(2, 2))

    def fail(*args, **kwargs):
        raise AssertionError("the digest must not run before the MIME check")

    monkeypatch.setattr(inspect_module, "sha256_of_file", fail)

    with VisionLens.local() as client:
        with pytest.raises(MimeMismatchError):
            client.datasets.inspect(image)


# --- the client lifecycle ----------------------------------------------------


def test_the_client_is_a_context_manager_and_closes():
    with VisionLens.local(LocalConfig(device="auto")) as client:
        assert client.capabilities().device == "cpu"

    with pytest.raises(ClientClosedError) as caught:
        client.capabilities()

    assert caught.value.code.value == "CLIENT_CLOSED"


def test_close_is_idempotent():
    client = VisionLens.local()

    client.close()
    client.close()

    assert client.config.device == "auto"


# --- drift guards ------------------------------------------------------------


def test_the_capability_extras_match_the_declared_extras():
    import tomllib

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    declared = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    extras = declared["project"]["optional-dependencies"]

    assert set(extras) == set(EXTRA_NAMES)


def test_the_library_codes_stay_out_of_the_frozen_wire_vocabulary():
    wire = {code.value for code in ErrorCode}
    library = {code.value for code in LibraryErrorCode}

    assert wire.isdisjoint(library)
