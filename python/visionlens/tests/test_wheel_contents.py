"""The built artifacts: shape, typing marker and the universal wheel."""

from __future__ import annotations

import tarfile
import zipfile
from pathlib import Path

from conftest import PKG_ROOT


def test_build_produces_exactly_one_wheel_and_one_sdist(built_dist: Path) -> None:
    wheels = sorted(p.name for p in built_dist.glob("*.whl"))
    sdists = sorted(p.name for p in built_dist.glob("*.tar.gz"))
    assert wheels == ["visionlens-0.1.0-py3-none-any.whl"]
    assert sdists == ["visionlens-0.1.0.tar.gz"]


def test_wheel_is_a_pure_python_universal_wheel(built_dist: Path) -> None:
    wheel = next(built_dist.glob("*.whl"))
    assert wheel.name.endswith("-py3-none-any.whl")


def test_wheel_contains_the_pytyped_marker(built_dist: Path) -> None:
    wheel = next(built_dist.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        assert "visionlens/py.typed" in archive.namelist()


def test_sdist_contains_the_pytyped_marker(built_dist: Path) -> None:
    sdist = next(built_dist.glob("*.tar.gz"))
    with tarfile.open(sdist) as archive:
        names = archive.getnames()
    assert any(name.endswith("src/visionlens/py.typed") for name in names)


def test_wheel_metadata_identity(built_dist: Path) -> None:
    wheel = next(built_dist.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        metadata_name = next(n for n in archive.namelist() if n.endswith(".dist-info/METADATA"))
        metadata = archive.read(metadata_name).decode("utf-8")
    headers = metadata.split("\n\n", 1)[0]
    assert "Name: visionlens\n" in headers
    assert "Version: 0.1.0\n" in headers
    assert "Requires-Python: >=3.11\n" in headers


def test_wheel_installs_into_a_clean_venv_without_node_on_path(
    built_dist: Path, tmp_path: Path
) -> None:
    """The US1 clean-venv proof, fast in-process variant of gate step two."""
    import os
    import shutil
    import subprocess
    import sys

    venv = tmp_path / "venv"
    completed = subprocess.run(
        [sys.executable, "-m", "venv", str(venv)], capture_output=True, text=True, timeout=120
    )
    assert completed.returncode == 0, completed.stderr

    keep = [
        d
        for d in os.environ.get("PATH", "").split(os.pathsep)
        if d and not os.path.exists(os.path.join(d, "node"))
    ]
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "VIRTUAL_ENV")}
    env["PATH"] = os.pathsep.join(keep)
    assert shutil.which("node", path=env["PATH"]) is None

    wheel = next(built_dist.glob("*.whl"))
    python = str(venv / "bin" / "python")
    install = subprocess.run(
        [python, "-m", "pip", "install", "--quiet", str(wheel)],
        capture_output=True,
        text=True,
        env=env,
        timeout=300,
    )
    assert install.returncode == 0, install.stderr

    check = (
        "import pathlib, sys, visionlens\n"
        "assert visionlens.__version__ == '0.1.0'\n"
        "assert (pathlib.Path(visionlens.__file__).parent / 'py.typed').exists()\n"
        "heavy = [m for m in ('torch', 'transformers', 'mlflow', 'langgraph', 'fastapi',"
        " 'uvicorn', 'scikit-learn') if m in sys.modules]\n"
        "assert not heavy, heavy\n"
        "print('CLEAN')\n"
    )
    run = subprocess.run(
        [python, "-c", check], capture_output=True, text=True, env=env, timeout=120
    )
    assert run.returncode == 0, run.stderr
    assert run.stdout.strip() == "CLEAN"


def test_pkg_root_is_the_package_root() -> None:
    # Guards the conftest import used above against a reshuffle of tests/.
    assert (PKG_ROOT / "pyproject.toml").exists()
