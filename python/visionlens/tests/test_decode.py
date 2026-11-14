"""The image decoder: the pixels, and every refusal before them.

The refusals are the security controls, so each test proves one of them
and proves that it happens BEFORE the pixels are allocated: the file the
test hands over is either truncated or lies about its size, so a decoder
that decoded first would fail differently.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.errors import (
    ImageDimensionsExceededError,
    ImageMetadataUnreadableError,
    MimeMismatchError,
    PathNotFoundError,
    PathOutsideRootError,
    UnsupportedFileTypeError,
)
from visionlens.io.decode import (
    ALLOWED_MIME_TYPES,
    EXTENSION_MIME,
    DecodeService,
    detect_mime_type,
)


def _png_bytes(width: int, height: int, pixels: bytes = b"") -> bytes:
    """A PNG file that declares its dimensions in the header.

    The body may be empty on purpose: a decoder that refuses on the
    declared size never reaches the body.
    """
    header = struct.pack(">II", width, height) + b"\x08\x02\x00\x00\x00"
    chunk = struct.pack(">I", len(header)) + b"IHDR" + header
    chunk += struct.pack(">I", zlib.crc32(b"IHDR" + header))
    if pixels:
        body = struct.pack(">I", len(pixels)) + b"IDAT" + pixels
        body += struct.pack(">I", zlib.crc32(b"IDAT" + pixels))
        chunk += body
    end = b"IEND" + struct.pack(">I", zlib.crc32(b"IEND"))
    return b"\x89PNG\r\n\x1a\n" + chunk + end


def _jpeg_bytes(width: int = 4, height: int = 4) -> bytes:
    """A JPEG that declares its dimensions in the frame header."""
    frame = b"\xff\xc0" + struct.pack(">H", 11) + b"\x08" + struct.pack(">HH", height, width)
    frame += b"\x03\x01\x11\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + frame + b"\xff\xd9"


def _write_png(root: Path, name: str = "image.png", width: int = 8, height: int = 8) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_png_bytes(width, height, b"\x00" * 16))
    return path


def test_a_png_inside_the_root_is_decoded(tmp_path: Path):
    service = DecodeService(tmp_path)
    path = _write_png(tmp_path)

    decoded = service.decode(path)

    assert decoded.mime_type == "image/png"
    assert decoded.width == 8
    assert decoded.height == 8
    assert decoded.transformed is False
    assert decoded.orientation == 1
    assert decoded.orientation_name == "upper-left"
    assert decoded.image.size == (8, 8)


def test_the_decoder_never_rewrites_the_original_bytes(tmp_path: Path):
    service = DecodeService(tmp_path)
    path = _write_png(tmp_path)
    before = path.read_bytes()

    service.decode(path)

    assert path.read_bytes() == before


def test_a_truncated_jpeg_is_refused(tmp_path: Path):
    # Task 2.5: a truncated JPEG is refused, and it is refused before the
    # pixels are decoded.
    service = DecodeService(tmp_path)
    path = tmp_path / "broken.jpg"
    path.write_bytes(_jpeg_bytes()[:-4])

    with pytest.raises(ImageMetadataUnreadableError) as excinfo:
        service.decode(path)

    assert "truncated" in str(excinfo.value)


def test_a_pixel_bomb_is_refused_before_the_pixels_are_allocated(tmp_path: Path):
    # Task 2.5: the declared size is over the cap, and the file carries no
    # pixels at all, so a decoder that decoded first would fail with a
    # different error.
    service = DecodeService(tmp_path)
    path = tmp_path / "bomb.png"
    path.write_bytes(_png_bytes(20001, 10))

    with pytest.raises(ImageDimensionsExceededError) as excinfo:
        service.decode(path)

    assert "20001" in str(excinfo.value)


def test_an_image_with_too_many_pixels_is_refused(tmp_path: Path):
    # The other cap: the sides are inside the per-side cap, but the pixel
    # count is over the one the decoder accepts.
    service = DecodeService(tmp_path)
    path = tmp_path / "many-pixels.png"
    path.write_bytes(_png_bytes(10001, 10001))

    with pytest.raises(ImageDimensionsExceededError) as excinfo:
        service.decode(path)

    assert "pixel count" in str(excinfo.value)


def test_a_file_whose_magic_bytes_contradict_its_name_is_refused(tmp_path: Path):
    # Task 2.5: a PNG named .jpg is refused.
    service = DecodeService(tmp_path)
    path = tmp_path / "actually-a-png.jpg"
    path.write_bytes(_png_bytes(8, 8, b"\x00" * 16))

    with pytest.raises(MimeMismatchError) as excinfo:
        service.decode(path)

    assert "image/png" in str(excinfo.value)
    assert "image/jpeg" in str(excinfo.value)


def test_a_file_that_is_not_an_image_is_refused(tmp_path: Path):
    service = DecodeService(tmp_path)
    path = tmp_path / "notes.png"
    path.write_bytes(b"this is not an image at all")

    with pytest.raises(UnsupportedFileTypeError) as excinfo:
        service.decode(path)

    assert "not one of the accepted image types" in str(excinfo.value)


def test_a_path_outside_the_approved_root_is_refused(tmp_path: Path):
    # Task 4.4: a traversal is refused, and so is a path that simply
    # lives somewhere else.
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.png"
    outside.write_bytes(_png_bytes(8, 8, b"\x00" * 16))
    service = DecodeService(root)

    with pytest.raises(PathOutsideRootError) as excinfo:
        service.decode(outside)

    assert "outside" in str(excinfo.value)


def test_a_traversal_out_of_the_approved_root_is_refused(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "outside.png").write_bytes(_png_bytes(8, 8, b"\x00" * 16))
    service = DecodeService(root)

    with pytest.raises(PathOutsideRootError):
        service.decode(root / ".." / "outside.png")


def test_a_symlink_that_escapes_the_approved_root_is_refused(tmp_path: Path):
    # A symlink inside the root that points out of it resolves out of it.
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.png"
    outside.write_bytes(_png_bytes(8, 8, b"\x00" * 16))
    (root / "link.png").symlink_to(outside)
    service = DecodeService(root)

    with pytest.raises(PathOutsideRootError):
        service.decode(root / "link.png")


def test_a_path_that_names_no_file_is_refused(tmp_path: Path):
    service = DecodeService(tmp_path)

    with pytest.raises(PathNotFoundError):
        service.decode(tmp_path / "missing.png")


def test_an_orientation_that_is_not_the_upper_left_one_is_normalized(tmp_path: Path):
    # Task 2.6: a non-upper-left EXIF orientation is a derived transform,
    # and the decoder records that it applied it.
    from PIL import Image

    service = DecodeService(tmp_path)
    path = tmp_path / "rotated.jpg"
    image = Image.new("RGB", (4, 2), (10, 20, 30))
    exif = image.getexif()
    exif[0x0112] = 6
    image.save(path, format="JPEG", exif=exif)
    before = path.read_bytes()

    decoded = service.decode(path)

    assert decoded.orientation == 6
    assert decoded.orientation_name == "right-top"
    assert decoded.transformed is True
    # The transform is derived: the bytes on the disk are untouched.
    assert path.read_bytes() == before


def test_the_magic_bytes_name_the_type_and_not_the_file_name():
    assert detect_mime_type(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8) == "image/png"
    assert detect_mime_type(b"\xff\xd8\xff\xe0" + b"\x00" * 8) == "image/jpeg"
    assert detect_mime_type(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert detect_mime_type(b"II*\x00" + b"\x00" * 8) == "image/tiff"
    assert detect_mime_type(b"\x00\x00\x00\x20ftypavif" + b"\x00" * 4) == "image/avif"
    assert detect_mime_type(b"not an image") is None


def test_the_allowlist_is_the_one_the_typescript_side_validates():
    # packages/core/src/utils/mime.ts:9 names the accepted types, and the
    # Python side takes the same list.
    assert ALLOWED_MIME_TYPES == (
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/tiff",
        "image/avif",
    )
    assert set(EXTENSION_MIME.values()) <= set(ALLOWED_MIME_TYPES)
