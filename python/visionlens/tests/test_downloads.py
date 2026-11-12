"""The opt-in download boundary: no permission plus provenance, no fetch."""

from __future__ import annotations

from helpers import SRC  # noqa: F401  (path setup)

import pytest

from visionlens.downloads import (
    DOWNLOAD_REFUSED,
    AuthorizedDownload,
    DownloadProvenance,
    DownloadRefusedError,
    authorize_download,
)

PROVENANCE = DownloadProvenance(
    source="https://huggingface.co/google/siglip2-base-patch16-224",
    revision="r2026-03-01",
    license="apache-2.0",
    sha256="a" * 64,
)


def test_refuses_without_explicit_permission() -> None:
    with pytest.raises(DownloadRefusedError) as caught:
        authorize_download("model", "siglip2-base", permitted=False, provenance=PROVENANCE)
    error = caught.value
    assert error.code == DOWNLOAD_REFUSED
    assert error.reason == "PERMISSION_MISSING"
    assert "permission" in error.message


def test_refuses_without_recorded_provenance() -> None:
    with pytest.raises(DownloadRefusedError) as caught:
        authorize_download("dataset", "visa-subset", permitted=True, provenance=None)
    error = caught.value
    assert error.code == DOWNLOAD_REFUSED
    assert error.reason == "PROVENANCE_MISSING"
    assert "provenance" in error.message


def test_authorizes_when_permission_and_provenance_are_present() -> None:
    authorized = authorize_download("model", "siglip2-base", permitted=True, provenance=PROVENANCE)
    assert isinstance(authorized, AuthorizedDownload)
    assert authorized.kind == "model"
    assert authorized.name == "siglip2-base"
    assert authorized.provenance is PROVENANCE


def test_the_stable_code_is_not_a_worker_wire_code() -> None:
    # The wire vocabulary is frozen; the download boundary is library-level
    # and must never leak into it.
    from visionlens.errors import ErrorCode

    assert DOWNLOAD_REFUSED not in {code.value for code in ErrorCode}


def test_provenance_refuses_empty_license() -> None:
    with pytest.raises(ValueError, match="license"):
        DownloadProvenance(
            source="https://example.org/model", revision="r1", license="", sha256="b" * 64
        )


def test_provenance_refuses_malformed_digest() -> None:
    with pytest.raises(ValueError, match="sha256"):
        DownloadProvenance(
            source="https://example.org/model",
            revision="r1",
            license="apache-2.0",
            sha256="not-a-digest",
        )


def test_provenance_refuses_floating_revision() -> None:
    with pytest.raises(ValueError, match="latest"):
        DownloadProvenance(
            source="https://example.org/model",
            revision="latest",
            license="apache-2.0",
            sha256="c" * 64,
        )
