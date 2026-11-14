"""The image decoder: the pixels, and every refusal before them.

Untrusted bytes become pixels here, so the refusals come first and they
come in the cheap order: a path is resolved before the file is opened, a
file's magic bytes are read before its header is parsed, and the
declared dimensions are checked before the pixel buffer is allocated.

The pack names the controls this implements: the MIME allowlist of the
platform (`packages/core/src/utils/mime.ts:9`), the dimension and pixel
caps (`docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:23`), and the
path resolution that forbids a traversal and a symlink escape
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:42`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional

from ..data.inspect import MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, read_dimensions
from ..errors import (
    ImageDimensionsExceededError,
    ImageMetadataUnreadableError,
    MimeMismatchError,
    PathOutsideRootError,
    PathNotFoundError,
    UnsupportedFileTypeError,
)
from ..hashing import sha256_of_file

#: The image types the platform accepts. This is the list the TypeScript
#: side validates against, so an input one side takes is an input the
#: other side takes (`packages/core/src/utils/mime.ts:9`).
ALLOWED_MIME_TYPES: tuple[str, ...] = (
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff",
    "image/avif",
)

#: The MIME type each known extension claims.
EXTENSION_MIME: Mapping[str, str] = {
    ".avif": "image/avif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
}

#: The bytes read to identify a file by its magic bytes.
_MAGIC_BYTES = 16

#: The EXIF orientation tag, and the name of every value it may carry.
#: The value 1 is the upper-left orientation: the image as it was taken.
EXIF_ORIENTATION_TAG = 0x0112

ORIENTATION_NAMES: Mapping[int, str] = {
    1: "upper-left",
    2: "upper-right",
    3: "lower-right",
    4: "lower-left",
    5: "left-top",
    6: "right-top",
    7: "right-bottom",
    8: "left-bottom",
}


def detect_mime_type(header: bytes) -> Optional[str]:
    """The MIME type of a file, read from its magic bytes.

    The bytes are the evidence, not the name of the file: a PNG renamed
    to .jpg is a PNG, and the decoder says so.

    @returns the MIME type, or None when the bytes are not an image.
    """
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    if header.startswith(b"II*\x00") or header.startswith(b"MM\x00*"):
        return "image/tiff"
    if len(header) >= 12 and header[4:8] == b"ftyp":
        brand = header[8:12]
        if brand in (b"avif", b"avis"):
            return "image/avif"
    return None


@dataclass(frozen=True)
class DecodedImage:
    """One decoded image, and what was proven about it.

    `image` is the decoded picture. It is not part of the identity of the
    record: two decodes of the same bytes are the same record.
    """

    path: Path
    mime_type: str
    width: int
    height: int
    sha256: str
    orientation: int
    orientation_name: str
    transformed: bool
    image: Any = field(compare=False, repr=False)


class DecodeService:
    """Decode images that live under an approved root.

    The root is required. A decoder that may read any path of the
    machine is a decoder that reads whatever a caller names, and the
    pack forbids a path from client input being trusted
    (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:42`).
    """

    def __init__(self, root: Path) -> None:
        self._root = Path(root).expanduser().resolve()

    @property
    def root(self) -> Path:
        """The approved root every decoded path lives under."""
        return self._root

    def resolve(self, path: Path) -> Path:
        """Resolve a path inside the approved root.

        A traversal and a symlink escape are the same refusal: the
        resolved path has to be inside the root, and a symlink that
        points out of it resolves out of it.

        @raises PathOutsideRootError when the path leaves the root.
        @raises PathNotFoundError when the path names no readable file.
        """
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = self._root / candidate
        resolved = candidate.resolve()
        if resolved != self._root and not resolved.is_relative_to(self._root):
            raise PathOutsideRootError(
                "the path '"
                + str(path)
                + "' resolves to '"
                + str(resolved)
                + "', which is outside the approved root '"
                + str(self._root)
                + "'"
            )
        if not resolved.is_file():
            raise PathNotFoundError(
                "the path '" + str(resolved) + "' does not name a readable file"
            )
        return resolved

    def decode(self, path: Path) -> DecodedImage:
        """Decode one image, or refuse it with its reason.

        The order of the refusals is the property: the path, then the
        magic bytes, then the name of the file, then the type, then the
        completeness, then the dimensions, and only then the pixels.

        @raises PathOutsideRootError when the path leaves the root.
        @raises PathNotFoundError when the path names no readable file.
        @raises MimeMismatchError when the magic bytes contradict the name.
        @raises UnsupportedFileTypeError when the type is not accepted.
        @raises ImageMetadataUnreadableError when the file is not complete.
        @raises ImageDimensionsExceededError when the dimensions are over the caps.
        """
        resolved = self.resolve(path)
        header = self._read_header(resolved)
        detected = detect_mime_type(header)
        if detected is None:
            raise UnsupportedFileTypeError(
                "the file '"
                + str(resolved)
                + "' is not one of the accepted image types ("
                + ", ".join(ALLOWED_MIME_TYPES)
                + ")"
            )
        claimed = EXTENSION_MIME.get(resolved.suffix.lower())
        if claimed is None:
            raise UnsupportedFileTypeError(
                "the name of the file '"
                + str(resolved)
                + "' is not one of the accepted image names ("
                + ", ".join(sorted(EXTENSION_MIME))
                + ")"
            )
        if claimed != detected:
            raise MimeMismatchError(
                "the file extension claims "
                + claimed
                + " but the magic bytes say "
                + detected
            )
        if detected not in ALLOWED_MIME_TYPES:
            raise UnsupportedFileTypeError(
                "the type "
                + detected
                + " is not one the platform accepts ("
                + ", ".join(ALLOWED_MIME_TYPES)
                + ")"
            )
        self._check_complete(resolved, detected)
        # The declared size is read from the header and refused here, before
        # any decoder is handed the file and before the pixel buffer exists.
        declared = read_dimensions(resolved, detected)
        if declared is not None:
            self._check_dimensions(declared[0], declared[1])
        picture = self._open(resolved)
        width, height = picture.size
        self._check_dimensions(width, height)
        return self._finish(resolved, detected, picture)

    def _read_header(self, path: Path) -> bytes:
        """The first bytes of a file, for the magic-byte check."""
        try:
            with path.open("rb") as handle:
                return handle.read(_MAGIC_BYTES)
        except OSError as exc:
            raise PathNotFoundError(
                "the file '"
                + str(path)
                + "' could not be read: "
                + (exc.strerror or exc.__class__.__name__)
            ) from exc

    def _check_complete(self, path: Path, mime_type: str) -> None:
        """Refuse a file that was cut short.

        A truncated file is refused before it is decoded, because a
        decoder that starts on a truncated file spends its budget on
        bytes that are not there.

        @raises ImageMetadataUnreadableError when the file is incomplete.
        """
        try:
            size_bytes = path.stat().st_size
        except OSError as exc:
            raise ImageMetadataUnreadableError(
                "the file '" + str(path) + "' could not be read: " + str(exc)
            ) from exc
        if mime_type == "image/jpeg":
            if size_bytes < 4:
                raise ImageMetadataUnreadableError(
                    "the file '"
                    + str(path)
                    + "' is too short to be a JPEG: it carries "
                    + str(size_bytes)
                    + " bytes"
                )
            with path.open("rb") as handle:
                handle.seek(-2, 2)
                tail = handle.read(2)
            if tail != b"\xff\xd9":
                raise ImageMetadataUnreadableError(
                    "the file '"
                    + str(path)
                    + "' is a truncated JPEG: it does not end with the end-of-image "
                    "marker"
                )
            return
        if mime_type == "image/png":
            if size_bytes < 12:
                raise ImageMetadataUnreadableError(
                    "the file '"
                    + str(path)
                    + "' is too short to be a PNG: it carries "
                    + str(size_bytes)
                    + " bytes"
                )
            with path.open("rb") as handle:
                handle.seek(-12, 2)
                tail = handle.read(12)
            if b"IEND" not in tail:
                raise ImageMetadataUnreadableError(
                    "the file '"
                    + str(path)
                    + "' is a truncated PNG: it does not end with the end-of-image "
                    "chunk"
                )

    def _open(self, path: Path) -> Any:
        """Open the picture, without decoding its pixels yet.

        @raises ImageMetadataUnreadableError when the file cannot be read.
        """
        from PIL import Image, UnidentifiedImageError

        # The cap of the platform is the cap of the decoder: Pillow's own
        # guard is raised to it, so the number the documentation names is
        # the number that is enforced.
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

        try:
            picture = Image.open(path)
        except Image.DecompressionBombError as exc:
            raise ImageDimensionsExceededError(
                "the file '"
                + str(path)
                + "' declares more pixels than the decoder accepts: "
                + str(exc)
            ) from exc
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise ImageMetadataUnreadableError(
                "the file '"
                + str(path)
                + "' could not be read as an image: "
                + ((exc.strerror or exc.__class__.__name__) if isinstance(exc, OSError) else str(exc))
            ) from exc
        return picture

    def _check_dimensions(self, width: int, height: int) -> None:
        """Refuse the declared dimensions that are over the caps.

        The check runs on the declared size, BEFORE the pixels are
        decoded, so a bomb is refused without the allocation it asks
        for.

        @raises ImageDimensionsExceededError when the dimensions are over.
        """
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

    def _finish(self, path: Path, mime_type: str, picture: Any) -> DecodedImage:
        """Decode the pixels, normalize the orientation and record both."""
        from PIL import ImageOps

        orientation = 1
        try:
            exif = picture.getexif()
            value = exif.get(EXIF_ORIENTATION_TAG)
            if isinstance(value, int) and value in ORIENTATION_NAMES:
                orientation = value
        except Exception:  # pragma: no cover - a file with no readable EXIF
            orientation = 1
        transformed = orientation != 1
        try:
            if transformed:
                decoded = ImageOps.exif_transpose(picture)
            else:
                decoded = picture.copy()
            decoded.load()
        except (OSError, ValueError) as exc:
            raise ImageMetadataUnreadableError(
                "the pixels of '"
                + str(path)
                + "' could not be decoded: "
                + ((exc.strerror or exc.__class__.__name__) if isinstance(exc, OSError) else str(exc))
            ) from exc
        width, height = decoded.size
        return DecodedImage(
            path=path,
            mime_type=mime_type,
            width=width,
            height=height,
            sha256=sha256_of_file(path),
            orientation=orientation,
            orientation_name=ORIENTATION_NAMES[orientation],
            transformed=transformed,
            image=decoded,
        )
