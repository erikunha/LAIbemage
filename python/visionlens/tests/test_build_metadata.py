"""The built metadata: the five extras, and none of them mandatory."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

FIVE_EXTRAS = {"vision", "training", "agents", "server", "all"}

# The base install carries exactly Pydantic, which the typed configuration of
# the public facade needs (the base-install policy of the pack,
# docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34). The packaging amendment of
# ADR-011 records the decision and replaces the earlier empty-set assertion.
MANDATORY_DISTRIBUTIONS = ["pydantic"]

# The published range of that base dependency, pinned because the ADR
# amendment and the license audit both name it.
MANDATORY_REQUIREMENT = "pydantic<3,>=2.12"

# The heavy stack the `vision` extra carries: the encoder that reads a real
# checkpoint (torch, transformers), the format the weights loader publishes
# (safetensors) and the decoder that opens an image (pillow). The base
# install carries none of them, so the base never pulls a PyTorch or a
# Transformers download (docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34, :35).
VISION_EXTRA_DISTRIBUTIONS = {"torch", "transformers", "safetensors", "pillow"}


def _distribution_name(requirement: str) -> str:
    """The distribution name of a Requires-Dist line, without its specifier."""
    head = requirement.split(" ")[0].split("[")[0].split(";")[0]
    return re.split(r"[<>=!~]", head)[0].strip()


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
        assert extra not in [_distribution_name(r) for r in mandatory]
    # The base install carries exactly Pydantic and nothing else: the heavy
    # stacks stay behind the extras.
    assert [_distribution_name(r) for r in mandatory] == MANDATORY_DISTRIBUTIONS


def test_the_base_dependency_pins_its_published_range(built_dist: Path) -> None:
    metadata = _metadata(built_dist)
    requires = [
        line.split(":", 1)[1].strip()
        for line in metadata.splitlines()
        if line.startswith("Requires-Dist:")
    ]
    mandatory = [r for r in requires if "extra ==" not in r]
    assert mandatory == [MANDATORY_REQUIREMENT]


def test_the_vision_extra_carries_the_heavy_stack(built_dist: Path) -> None:
    metadata = _metadata(built_dist)
    requires = [
        line.split(":", 1)[1].strip()
        for line in metadata.splitlines()
        if line.startswith("Requires-Dist:")
    ]
    vision = {
        _distribution_name(r) for r in requires if "extra == 'vision'" in r
    }
    assert vision == VISION_EXTRA_DISTRIBUTIONS
    # The aggregate pulls the same stack, so `all` is never a weaker
    # install than the extra it aggregates.
    aggregate = {
        _distribution_name(r) for r in requires if "extra == 'all'" in r
    }
    assert aggregate == VISION_EXTRA_DISTRIBUTIONS


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
