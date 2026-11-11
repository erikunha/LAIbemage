"""Smoke test for the vision service skeleton (spec 005)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vision_lens_vision import SERVICE_NAME


def test_service_name_constant() -> None:
    assert SERVICE_NAME == "vision"
