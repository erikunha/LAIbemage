"""The opt-in download boundary for model and dataset artifacts.

A model or dataset artifact is never fetched implicitly. Before any hub or
registry fetch, the caller must hold explicit permission plus a recorded
provenance (source, exact revision, license, sha256 digest); anything less
is refused with a typed error
(docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:10,15). This module is the
refusal boundary only: it authorizes a request and never performs IO.

The stable code DOWNLOAD_REFUSED is a library-level code. It is not part of
the frozen worker wire vocabulary and never crosses the wire.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: Stable library-level error code for a refused download (not a wire code).
DOWNLOAD_REFUSED = "DOWNLOAD_REFUSED"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class DownloadRefusedError(Exception):
    """A download request that lacked permission or recorded provenance."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.code = DOWNLOAD_REFUSED
        self.reason = reason
        self.message = message


@dataclass(frozen=True)
class DownloadProvenance:
    """The recorded provenance every download must carry.

    Mirrors the registry rules: an exact revision (the floating tag "latest"
    is refused), a named license and a lowercase hex sha256 digest.
    """

    source: str
    revision: str
    license: str
    sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.source, str) or not self.source:
            raise ValueError("provenance must record a non-empty source")
        if not isinstance(self.revision, str) or not self.revision:
            raise ValueError("provenance must pin a non-empty revision")
        if self.revision == "latest":
            # A floating revision can never be verified against the digest,
            # so the boundary refuses it at construction time.
            raise ValueError("provenance refuses the floating revision 'latest'")
        if not isinstance(self.license, str) or not self.license:
            raise ValueError("provenance must record a non-empty license")
        if not isinstance(self.sha256, str) or not _SHA256.match(self.sha256):
            raise ValueError(
                "provenance must record a sha256 digest as 64 lowercase hex characters"
            )


@dataclass(frozen=True)
class AuthorizedDownload:
    """A download request that passed the boundary. Carrying the proof."""

    kind: str
    name: str
    provenance: DownloadProvenance


def authorize_download(
    kind: str,
    name: str,
    *,
    permitted: bool,
    provenance: DownloadProvenance | None,
) -> AuthorizedDownload:
    """Authorize one download, or refuse it with a typed error.

    The caller passes ``permitted`` explicitly (an opt-in, never a default)
    and the recorded provenance; the boundary refuses the request unless both
    are present, so no code path can reach a fetch without them.
    """
    if not isinstance(kind, str) or kind not in ("model", "dataset"):
        raise ValueError("kind must be 'model' or 'dataset'")
    if not isinstance(name, str) or not name:
        raise ValueError("name must be a non-empty string")
    if provenance is None:
        raise DownloadRefusedError(
            "PROVENANCE_MISSING",
            "download of "
            + kind
            + " '"
            + name
            + "' is refused: no recorded provenance (source, revision, license, sha256)",
        )
    if not permitted:
        raise DownloadRefusedError(
            "PERMISSION_MISSING",
            "download of "
            + kind
            + " '"
            + name
            + "' is refused: no explicit permission was granted",
        )
    return AuthorizedDownload(kind=kind, name=name, provenance=provenance)
