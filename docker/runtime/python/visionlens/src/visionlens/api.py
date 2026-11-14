"""The public client facade (spec 017, US3).

The facade is the shape the pack documents: a local client opened from a
versioned configuration, asked what it can do, pointed at an image, and closed.
It is the only surface a Python consumer needs to touch, and it works from a
Python process alone: no Node, no server and no network.
"""

from __future__ import annotations

from pathlib import Path

from .capabilities import Capabilities, ExtraCapability, resolve_capabilities
from .config import LocalConfig
from .data.inspect import DatasetInspection, inspect_image
from .errors import ClientClosedError


class Datasets:
    """The dataset operations of a local client."""

    def __init__(self, client: "VisionLens") -> None:
        self._client = client

    def inspect(self, path: str | Path) -> DatasetInspection:
        """Read the metadata of the image at `path`.

        Returns the width, the height, the MIME type and the sha256 of the
        bytes. Raises a typed error, carrying a stable code, when the path
        names no file, when the file is not a supported image, when the
        extension contradicts the magic bytes or when the declared dimensions
        exceed the cap.
        """
        self._client._require_open()
        return inspect_image(path)


class VisionLens:
    """The public client of the local runtime."""

    def __init__(self, config: LocalConfig) -> None:
        self._config = config
        self._closed = False
        self._datasets = Datasets(self)

    @classmethod
    def local(cls, config: LocalConfig | None = None) -> "VisionLens":
        """Open a local client.

        The client is a context manager: leaving the block closes it and
        releases it.
        """
        return cls(config if config is not None else LocalConfig())

    @property
    def config(self) -> LocalConfig:
        """The configuration the client was opened with."""
        return self._config

    @property
    def datasets(self) -> Datasets:
        """The dataset operations of the client."""
        return self._datasets

    def capabilities(self) -> Capabilities:
        """What this client can do on this machine."""
        self._require_open()
        return resolve_capabilities(self._config)

    def close(self) -> None:
        """Release the client. Closing twice is not an error."""
        self._closed = True

    def __enter__(self) -> "VisionLens":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _require_open(self) -> None:
        if self._closed:
            raise ClientClosedError("the client is closed and serves no work")
