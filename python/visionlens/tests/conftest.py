"""Shared fixtures: path setup, artifact builds and worker driving helpers."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

PKG_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def built_dist(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Build the wheel and the sdist once per test session into a temp dir.

    Skipped where uv is absent (the CI runner installs pytest only), so the
    artifact tests degrade to skips instead of failures there.
    """
    if shutil.which("uv") is None:
        pytest.skip("uv is not installed; the artifact tests need it to build")
    out_dir = tmp_path_factory.mktemp("dist")
    completed = subprocess.run(
        ["uv", "build", "--out-dir", str(out_dir)],
        cwd=PKG_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert completed.returncode == 0, completed.stderr
    return out_dir
