"""The image metadata operation of the facade (spec 017, US3).

The operation reads the metadata of one image: its width, its height, its MIME
type and the sha256 of its bytes. It needs no Node, no server and no network,
and it reads only the header of the file: the pixels are never decoded and no
image library is required.

The header is read against the magic bytes of the file, never against its
name. The name is only allowed to agree with the bytes: an extension that
contradicts them is a mismatch and is refused, because a file whose type is
uncertain must not reach a consumer that trusts the type.

The order of the checks is a property: the type is identified, then the
dimensions are read and capped, and only then is the file digested. A file
that declares absurd dimensions is refused before its bytes are read to the
end.
"""

from __future__ import annotations

import os
import struct
from pathlib import Path
from typing import BinaryIO, Mapping

from pydantic import BaseModel, ConfigDict

from ..errors import (
    ImageDimensionsExceededError,
    ImageMetadataUnreadableError,
    MimeMismatchError,
    PathNotFoundError,
    UnsupportedFileTypeError,
)
from ..hashing import sha256_of_file

INSPECTION_SCHEMA_VERSION = 1

#: The largest side, in pixels, an inspected image may declare.
MAX_IMAGE_DIMENSION = 20000
#: The largest pixel count an inspected image may declare.
MAX_IMAGE_PIXELS = 100_000_000

#: The bytes read to identify the file and, for the formats that carry their
#: metadata at a fixed offset, to read it. The JPEG parser walks the file
#: itself, because a JPEG may carry more than this much metadata before its
#: frame header.
_HEADER_BYTES = 4096

#: The MIME type each known extension claims.
EXTENSION_MIME: Mapping[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_START_OF_FRAME_MARKERS = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)


class DatasetInspection(BaseModel):
    """The metadata of one inspected image."""

    model_config = ConfigDict(frozen=True)

    #: The schema version of this record.
    schema_version: int = INSPECTION_SCHEMA_VERSION
    #: The path that was inspected, as the caller named it.
    path: str
    #: The width in pixels.
    width: int
    #: The height in pixels.
    height: int
    #: The MIME type, read from the magic bytes of the file.
    mime_type: str
    #: The sha256 of the bytes of the file.
    sha256: str


def inspect_image(path: str | Path) -> DatasetInspection:
    """Read the metadata of the image at `path`.

    Refuses a path that names no readable file, a file whose magic bytes are
    not a supported image, an extension that contradicts those bytes, and an
    image whose declared dimensions exceed the cap.
    """
    target = Path(path)
    if not target.exists():
        raise PathNotFoundError("no file exists at the given path")
    if not target.is_file():
        raise PathNotFoundError("the given path is not a readable file")

    try:
        with target.open("rb") as handle:
            header = handle.read(_HEADER_BYTES)
            mime_type = _detect_type(header)
            if mime_type is None:
                raise UnsupportedFileTypeError(
                    "the file is not a supported image; the supported types are "
                    + ", ".join(sorted(set(EXTENSION_MIME.values())))
                )
            dimensions = _read_dimensions(mime_type, handle, header)
            if dimensions is None:
                raise ImageMetadataUnreadableError(
                    "the file is a " + mime_type + " but its metadata could not be read"
                )
            width, height = dimensions
    except OSError as exc:
        raise PathNotFoundError(
            "the file could not be read: " + (exc.strerror or exc.__class__.__name__)
        ) from exc

    expected = EXTENSION_MIME.get(target.suffix.lower())
    if expected is not None and expected != mime_type:
        raise MimeMismatchError(
            "the file extension claims "
            + expected
            + " but the magic bytes say "
            + mime_type
        )

    # The cap runs before the digest: a file that declares absurd dimensions
    # is refused before its bytes are read to the end.
    _check_dimensions(width, height)

    try:
        digest = sha256_of_file(target)
    except OSError as exc:
        raise PathNotFoundError(
            "the file could not be read: " + (exc.strerror or exc.__class__.__name__)
        ) from exc

    return DatasetInspection(
        path=str(path),
        width=width,
        height=height,
        mime_type=mime_type,
        sha256=digest,
    )


def _check_dimensions(width: int, height: int) -> None:
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        raise ImageDimensionsExceededError(
            "the declared dimensions "
            + str(width)
            + "x"
            + str(height)
            + " exceed the cap of "
            + str(MAX_IMAGE_DIMENSION)
            + " pixels per side"
        )
    if width * height > MAX_IMAGE_PIXELS:
        raise ImageDimensionsExceededError(
            "the declared pixel count "
            + str(width * height)
            + " exceeds the cap of "
            + str(MAX_IMAGE_PIXELS)
            + " pixels"
        )


def _detect_type(header: bytes) -> str | None:
    """The MIME type of the file, read from its magic bytes."""
    if header.startswith(_PNG_SIGNATURE):
        return "image/png"
    if header.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if header.startswith(b"GIF87a") or header.startswith(b"GIF89a"):
        return "image/gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def read_dimensions(path: Path, mime_type: str) -> tuple[int, int] | None:
    """The dimensions the header of a file declares, or None.

    The PNG, GIF and WebP headers carry the dimensions in their first
    bytes. A JPEG carries them in a frame header that may sit behind a
    large EXIF segment, so the markers are walked with a seek and the
    memory read stays bounded whatever the file holds.

    The caller that has to refuse a bomb reads the dimensions HERE,
    before it hands the file to a decoder that would allocate the pixel
    buffer.
    """
    if mime_type == "image/jpeg":
        try:
            with path.open("rb") as handle:
                return _jpeg(handle)
        except OSError:
            return None
    try:
        with path.open("rb") as handle:
            header = handle.read(_HEADER_BYTES)
    except OSError:
        return None
    if mime_type == "image/png":
        return _png(header)
    if mime_type == "image/gif":
        return _gif(header)
    if mime_type == "image/webp":
        return _webp(header)
    return None


def _read_dimensions(
    mime_type: str, handle: BinaryIO, header: bytes
) -> tuple[int, int] | None:
    """The dimensions of the image, or None when they cannot be read."""
    if mime_type == "image/png":
        return _png(header)
    if mime_type == "image/gif":
        return _gif(header)
    if mime_type == "image/webp":
        return _webp(header)
    return _jpeg(handle)


def _png(header: bytes) -> tuple[int, int] | None:
    position = len(_PNG_SIGNATURE)
    while position + 8 <= len(header):
        length = struct.unpack(">I", header[position : position + 4])[0]
        kind = header[position + 4 : position + 8]
        start = position + 8
        if kind == b"IHDR":
            if start + 8 > len(header):
                return None
            width, height = struct.unpack(">II", header[start : start + 8])
            return (width, height)
        position = start + length + 4
    return None


def _gif(header: bytes) -> tuple[int, int] | None:
    if len(header) < 10:
        return None
    width, height = struct.unpack("<HH", header[6:10])
    return (width, height)


def _webp(header: bytes) -> tuple[int, int] | None:
    if len(header) < 16:
        return None
    kind = header[12:16]
    if kind == b"VP8 ":
        if len(header) < 30 or header[23:26] != b"\x9d\x01\x2a":
            return None
        width = struct.unpack("<H", header[26:28])[0] & 0x3FFF
        height = struct.unpack("<H", header[28:30])[0] & 0x3FFF
        return (width, height)
    if kind == b"VP8L":
        if len(header) < 25 or header[20] != 0x2F:
            return None
        bits = struct.unpack("<I", header[21:25])[0]
        return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    if kind == b"VP8X":
        if len(header) < 30:
            return None
        width = int.from_bytes(header[24:27], "little") + 1
        height = int.from_bytes(header[27:30], "little") + 1
        return (width, height)
    return None


def _jpeg(handle: BinaryIO) -> tuple[int, int] | None:
    """The dimensions of a JPEG, found by walking its markers.

    The walk runs over the file rather than over a fixed window: a JPEG may
    carry a large EXIF or ICC segment before its frame header, and such a
    file is a valid image, not an unreadable one. Segment bodies are skipped
    with a seek, so the memory read stays bounded whatever the file holds.
    """
    handle.seek(0)
    if handle.read(2) != b"\xff\xd8":
        return None
    while True:
        if handle.read(1) != b"\xff":
            return None
        marker = handle.read(1)
        if not marker:
            return None
        code = marker[0]
        if code == 0xFF:
            # A fill byte before the marker: step back over it.
            handle.seek(-1, os.SEEK_CUR)
            continue
        if code == 0x01 or 0xD0 <= code <= 0xD8:
            # A standalone marker, with no length field.
            continue
        if code == 0xD9:
            return None
        length_bytes = handle.read(2)
        if len(length_bytes) < 2:
            return None
        length = struct.unpack(">H", length_bytes)[0]
        if length < 2:
            return None
        if code in _JPEG_START_OF_FRAME_MARKERS:
            payload = handle.read(5)
            if len(payload) < 5:
                return None
            height, width = struct.unpack(">HH", payload[1:5])
            return (width, height)
        if code == 0xDA:
            # The scan starts: no frame header was found before it.
            return None
        handle.seek(length - 2, os.SEEK_CUR)
