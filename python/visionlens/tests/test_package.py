"""The public surface and the import isolation contract."""

from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path

from helpers import SRC  # noqa: F401  (path setup)


def test_public_surface_exports():
    import visionlens

    assert visionlens.__version__ == "0.1.0"
    for name in visionlens.__all__:
        assert getattr(visionlens, name, None) is not None, name
    from visionlens import (
        ErrorCode,
        ModelRegistry,
        ModelSpec,
        UnknownModelError,
        Worker,
        WorkerError,
        embed_bytes,
    )

    assert issubclass(UnknownModelError, Exception)
    assert issubclass(WorkerError, Exception)
    assert ModelRegistry.default().resolve("siglip2-base").dimension == 768
    assert len(embed_bytes(b"x", ModelSpec(model_id="m", revision="r1", dimension=4))) == 4
    assert ErrorCode.CANCELLED.value == "CANCELLED"


def test_the_exported_version_matches_the_declared_version():
    """The version the package reports is the version it declares."""
    import visionlens

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    declared = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]

    assert visionlens.__version__ == declared


def test_base_import_loads_no_heavy_dependency():
    code = (
        "import sys\n"
        "import visionlens\n"
        "heavy = [m for m in ('numpy', 'torch', 'transformers', 'PIL', 'cv2') "
        "if m in sys.modules]\n"
        "print('HEAVY:' + ','.join(heavy) if heavy else 'CLEAN')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=60,
        env=_env(),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "CLEAN"


def test_worker_module_import_needs_no_heavy_dependency():
    code = (
        "import sys\n"
        "from visionlens import worker\n"
        "print('OK' if 'numpy' not in sys.modules else 'HEAVY')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=60,
        env=_env(),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "OK"


def _env() -> dict:
    import os

    env = dict(os.environ)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(SRC) if not existing else str(SRC) + os.pathsep + existing
    return env
