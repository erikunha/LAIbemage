"""The input side of the runtime: the bytes of an image, and their pixels.

The decoder is the place where untrusted bytes become pixels, so every
refusal stands between the two: the path must be inside the approved
root, the magic bytes must agree with the name of the file, the type must
be one the platform accepts, the declared dimensions must be inside the
caps, and the file must be complete. A refusal happens BEFORE the pixel
buffer is allocated, because a bomb that is refused after the allocation
has already cost the memory it was trying to take.

The decoder never rewrites the original bytes. An orientation that is not
the upper-left one is normalized as a DERIVED transform, and the decoder
records that it did.
"""

from __future__ import annotations

from .decode import (
    ALLOWED_MIME_TYPES,
    EXTENSION_MIME,
    DecodedImage,
    DecodeService,
    detect_mime_type,
)

__all__ = [
    "ALLOWED_MIME_TYPES",
    "EXTENSION_MIME",
    "DecodedImage",
    "DecodeService",
    "detect_mime_type",
]
