"""Golden transcript regeneration equality and CLI behavior."""

from __future__ import annotations

import json
import os
import subprocess
import sys

from helpers import SRC  # noqa: F401  (path setup)
from helpers import WorkerProc

from visionlens import golden, protocol


def test_golden_file_exists_and_is_non_empty():
    path = golden.golden_path()
    assert path.is_file()
    assert golden.read_golden().strip() != b""


def test_regeneration_is_byte_identical_in_process():
    assert golden.build_transcript() == golden.read_golden()


def test_regeneration_is_byte_identical_over_a_real_subprocess():
    with WorkerProc() as worker:
        for line in golden.SCRIPT:
            worker.send_raw(line + b"\n")
        worker.close_stdin()
        collected = bytearray()
        assert worker.proc.stdout is not None
        for chunk in iter(lambda: worker.proc.stdout.read(65536), b""):
            collected += chunk
        assert worker.wait() == 0
        assert bytes(collected) == golden.read_golden()


def test_golden_records_handshake_embed_and_an_error_case():
    lines = golden.read_golden().decode("utf-8").splitlines()
    frames = [json.loads(line) for line in lines]
    assert frames[0]["kind"] == "hello"
    assert frames[0]["protocolVersion"] == protocol.PROTOCOL_VERSION
    results = [f for f in frames if f["kind"] == "result"]
    errors = [f for f in frames if f["kind"] == "error"]
    assert len(results) == 1
    assert results[0]["requestId"] == "r-1"
    assert results[0]["result"]["count"] == 2
    assert len(errors) == 1
    assert errors[0]["code"] == "MALFORMED_FRAME"
    # the malformed-line case had no recoverable id, so its error frame omits
    # the requestId and seq keys entirely; seq strictly increases per
    # requestId among the frames that carry one
    assert "requestId" not in errors[0]
    assert "seq" not in errors[0]
    per_request: dict[str, list[int]] = {}
    for frame in frames[1:]:
        if "requestId" not in frame:
            continue
        per_request.setdefault(frame["requestId"], []).append(frame["seq"])
    assert per_request["r-1"] == list(range(len(per_request["r-1"])))


def test_golden_cli_check_passes():
    result = subprocess.run(
        [sys.executable, "-m", "visionlens.golden", "--check"],
        env=_module_env(),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr


def test_golden_cli_detects_tampering(tmp_path):
    tampered = tmp_path / "session.jsonl"
    tampered.write_bytes(golden.read_golden().replace(b"seq", b"sqx", 1))
    result = subprocess.run(
        [sys.executable, "-m", "visionlens.golden", "--check", str(tampered)],
        env=_module_env(),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 1
    assert "drifted" in result.stderr


def test_golden_cli_regen_round_trip(tmp_path):
    target = tmp_path / "session.jsonl"
    result = subprocess.run(
        [sys.executable, "-m", "visionlens.golden", "--regen", str(target)],
        env=_module_env(),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert target.read_bytes() == golden.read_golden()


def _module_env() -> dict:
    env = dict(os.environ)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(SRC) if not existing else str(SRC) + os.pathsep + existing
    return env
