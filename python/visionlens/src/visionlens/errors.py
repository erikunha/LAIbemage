"""Typed error codes: the frozen wire vocabulary and the library-level one.

The wire vocabulary, with the retryable flag of every code, is frozen in the
wire contract; the tracked statements live in
docs/vnext/contracts/proposed/worker-event.v1.schema.json. This module never
invents a wire code and never flips a retryable flag.

The library-level vocabulary below is a SEPARATE set: it belongs to the public
Python surface (the facade of spec 017, US3) and never crosses the wire. A
library code is not a wire code and is never added to the frozen vocabulary,
exactly as the download boundary keeps its own code out of it
(`downloads.py`).

Worker-side mapping decisions (the frozen table names the cause, the worker
picks the code):

- PROTOCOL_MISMATCH: any frame whose protocol field is not
  visionlens.worker.v1.
- UNSUPPORTED_PROTOCOL: a hello or a request whose version major differs from
  the worker's, an unsupported device, or any frame arriving before the host
  hello completes the handshake.
- MALFORMED_FRAME: an unparsable line, a wrong shape, an unknown or missing
  field, an oversized frame, or params naming an unknown model or recipe.
- MISSING_EXTRA: a registry model whose required extra is not installed.
- UNSUPPORTED_OPERATION: an operation code outside the advertised set.
- CANCELLED: the host asked to stop an in-flight request.
- DEADLINE_EXCEEDED: budget.maxSeconds elapsed before completion.
- BUDGET_EXCEEDED: the simulated token cost exceeds budget.maxTokens.
- WORKER_CRASHED: an unexpected internal failure; the worker keeps serving.
- PROVIDER_UNAVAILABLE: reserved for transient provider IO; the simulated
  path never emits it.
"""

from __future__ import annotations

import enum


class ErrorCode(str, enum.Enum):
    """The frozen error vocabulary of the worker protocol."""

    UNSUPPORTED_PROTOCOL = "UNSUPPORTED_PROTOCOL"
    MISSING_EXTRA = "MISSING_EXTRA"
    MALFORMED_FRAME = "MALFORMED_FRAME"
    PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH"
    UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION"
    CANCELLED = "CANCELLED"
    DEADLINE_EXCEEDED = "DEADLINE_EXCEEDED"
    BUDGET_EXCEEDED = "BUDGET_EXCEEDED"
    WORKER_CRASHED = "WORKER_CRASHED"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"


_RETRYABLE: dict[ErrorCode, bool] = {
    ErrorCode.UNSUPPORTED_PROTOCOL: False,
    ErrorCode.MISSING_EXTRA: False,
    ErrorCode.MALFORMED_FRAME: False,
    ErrorCode.PROTOCOL_MISMATCH: False,
    ErrorCode.UNSUPPORTED_OPERATION: False,
    ErrorCode.CANCELLED: False,
    ErrorCode.DEADLINE_EXCEEDED: False,
    ErrorCode.BUDGET_EXCEEDED: False,
    ErrorCode.WORKER_CRASHED: True,
    ErrorCode.PROVIDER_UNAVAILABLE: True,
}


def is_retryable(code: ErrorCode) -> bool:
    """Return the frozen retryable flag of an error code."""
    return _RETRYABLE[code]


class WorkerError(Exception):
    """A typed protocol failure carrying one of the frozen error codes."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def retryable(self) -> bool:
        """Return the frozen retryable flag of this error's code."""
        return is_retryable(self.code)


class LibraryErrorCode(str, enum.Enum):
    """The library-level error vocabulary of the public Python surface.

    These codes never appear on the wire: the frozen worker vocabulary stays
    exactly as it is, and every code here names a condition a Python caller
    can act on.
    """

    CLIENT_CLOSED = "CLIENT_CLOSED"
    CONFIG_INVALID = "CONFIG_INVALID"
    CONFIG_VERSION_UNSUPPORTED = "CONFIG_VERSION_UNSUPPORTED"
    IMAGE_DIMENSIONS_EXCEEDED = "IMAGE_DIMENSIONS_EXCEEDED"
    IMAGE_METADATA_UNREADABLE = "IMAGE_METADATA_UNREADABLE"
    MIME_MISMATCH = "MIME_MISMATCH"
    PATH_NOT_FOUND = "PATH_NOT_FOUND"
    UNSUPPORTED_DEVICE = "UNSUPPORTED_DEVICE"
    UNSUPPORTED_FILE_TYPE = "UNSUPPORTED_FILE_TYPE"


class LibraryError(Exception):
    """A typed failure of the public Python surface.

    The message is written for a caller: it names the condition and never
    carries a raw traceback.
    """

    def __init__(self, code: LibraryErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ClientClosedError(LibraryError):
    """The client was closed and no longer serves work."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.CLIENT_CLOSED, message)


class ConfigInvalidError(LibraryError):
    """The configuration payload is not a valid configuration."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.CONFIG_INVALID, message)


class ConfigVersionUnsupportedError(LibraryError):
    """The configuration carries a schema version this build does not speak."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.CONFIG_VERSION_UNSUPPORTED, message)


class ImageDimensionsExceededError(LibraryError):
    """The declared image dimensions exceed the cap."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.IMAGE_DIMENSIONS_EXCEEDED, message)


class ImageMetadataUnreadableError(LibraryError):
    """The file is an image, but its metadata could not be read."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.IMAGE_METADATA_UNREADABLE, message)


class MimeMismatchError(LibraryError):
    """The file extension contradicts the magic bytes of the file."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.MIME_MISMATCH, message)


class PathNotFoundError(LibraryError):
    """The path does not name a readable file."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.PATH_NOT_FOUND, message)


class UnsupportedDeviceError(LibraryError):
    """The requested device is not provided by this build."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.UNSUPPORTED_DEVICE, message)


class UnsupportedFileTypeError(LibraryError):
    """The file is not one of the supported image types."""

    def __init__(self, message: str) -> None:
        super().__init__(LibraryErrorCode.UNSUPPORTED_FILE_TYPE, message)
