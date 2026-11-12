"""The built metadata: the five extras, and none of them mandatory."""

from __future__ import annotations

import zipfile
from pathlib import Path

FIVE_EXTRAS = {"vision", "training", "agents", "server", "all"}


def _metadata(built_dist: Path) -> str:
    wheel = next(built_dist.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".dist-info/METADATA"))
        return archive.read(name).decode("utf-8")


def test_metadata_declares_exactly_the_five_extra_names(built_dist: Path) -> None:
    metadata = _metadata(built_dist)
    provided = {
        line.split(":", 1)[1].strip()
        for line in metadata.splitlines()
        if line.startswith("Provides-Extra:")
    }
    assert provided == FIVE_EXTRAS


def test_no_extra_name_appears_in_the_mandatory_dependency_list(built_dist: Path) -> None:
    metadata = _metadata(built_dist)
    requires = [
        line.split(":", 1)[1].strip()
        for line in metadata.splitlines()
        if line.startswith("Requires-Dist:")
    ]
    # A mandatory requirement is one without an `extra ==` environment marker.
    mandatory = [r for r in requires if "extra ==" not in r]
    for extra in FIVE_EXTRAS:
        assert extra not in [r.split(" ")[0].split("[")[0] for r in mandatory]
    # As built the runtime is standard-library only: nothing is mandatory.
    assert mandatory == []


def test_sdist_metadata_matches_the_wheel(built_dist: Path) -> None:
    import tarfile

    sdist = next(built_dist.glob("*.tar.gz"))
    with tarfile.open(sdist) as archive:
        member = next(m for m in archive.getmembers() if m.name.endswith("/PKG-INFO"))
        pkg_info = archive.extractfile(member)
        assert pkg_info is not None
        sdist_metadata = pkg_info.read().decode("utf-8")
    wheel_metadata = _metadata(built_dist)
    for field in ("Name:", "Version:", "Requires-Python:", "License-Expression:"):
        wheel_line = next(l for l in wheel_metadata.splitlines() if l.startswith(field))
        sdist_line = next(l for l in sdist_metadata.splitlines() if l.startswith(field))
        assert wheel_line == sdist_line
