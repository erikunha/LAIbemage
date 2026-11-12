"""Test helpers: in-memory sessions and a real subprocess worker driver."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Sequence

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from visionlens import protocol  # noqa: E402
from visionlens.worker import Worker  # noqa: E402

WORKER_MODULE = "visionlens.worker"


def host_hello(
    protocol_version: str = protocol.PROTOCOL_VERSION,
    contract_version: str = protocol.CONTRACT_VERSION,
    max_frame_bytes: int | None = None,
) -> dict[str, Any]:
    """Build the host hello object."""
    frame: dict[str, Any] = {
        "protocol": protocol.PROTOCOL,
        "kind": "hello",
        "protocolVersion": protocol_version,
        "contractVersion": contract_version,
    }
    if max_frame_bytes is not None:
        frame["maxFrameBytes"] = max_frame_bytes
    return frame


def request(
    request_id: str,
    operation: str,
    params: dict[str, Any],
    *,
    max_seconds: int = 60,
    max_usd_micro: int = 0,
    max_tokens: int | None = None,
    contract_version: str = protocol.CONTRACT_VERSION,
    workspace_id: str = "ws-test",
    wire_protocol: str = protocol.PROTOCOL,
) -> dict[str, Any]:
    """Build a request frame object."""
    budget: dict[str, Any] = {"maxSeconds": max_seconds, "maxUsdMicro": max_usd_micro}
    if max_tokens is not None:
        budget["maxTokens"] = max_tokens
    return {
        "protocol": wire_protocol,
        "kind": "request",
        "requestId": request_id,
        "operation": operation,
        "contractVersion": contract_version,
        "workspaceId": workspace_id,
        "params": params,
        "budget": budget,
    }


def encode(obj: dict[str, Any]) -> bytes:
    """Encode one host line."""
    return (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")


def run_session(lines: Sequence[bytes], *, extras: Sequence[str] = ()) -> tuple[list[dict[str, Any]], bytes, int]:
    """Drive a static script through an in-memory worker.

    Returns the parsed frames, the raw bytes and the exit code.
    """
    payload = b"".join(
        line if line.endswith(b"\n") else line + b"\n" for line in lines
    )
    reader = io.BytesIO(payload)
    writer = io.BytesIO()
    worker = Worker(reader=reader, writer=writer, extras=extras)
    code = worker.run()
    raw = writer.getvalue()
    frames = [json.loads(line) for line in raw.decode("utf-8").splitlines()]
    return frames, raw, code


def frames_for(frames: Sequence[dict[str, Any]], request_id: str) -> list[dict[str, Any]]:
    """Return the frames of one requestId in emission order."""
    return [f for f in frames if f.get("requestId") == request_id]


def terminal(frames: Sequence[dict[str, Any]], request_id: str) -> dict[str, Any]:
    """Return the single terminal frame (result or error) of a request."""
    terminals = [
        f
        for f in frames
        if f.get("requestId") == request_id and f.get("kind") in ("result", "error")
    ]
    assert len(terminals) == 1, "expected exactly one terminal frame, got " + repr(terminals)
    return terminals[0]


def assert_invariants(frames: Sequence[dict[str, Any]]) -> None:
    """Assert the frozen sequence rules over every emitted frame.

    The frozen rules: seq is strictly increasing per requestId and starts at
    0; completed never exceeds total; a result terminates its request, so no
    frame may follow a result for the same requestId; several error frames
    may share an id only as separate refused attempts (preflight refusals),
    never for one dispatched request.
    """
    seen_result: set[str] = set()
    last_seq: dict[str, int] = {}
    first = True
    for frame in frames:
        assert frame["protocol"] == protocol.PROTOCOL
        if first:
            assert frame["kind"] == "hello", "the first frame must be the unprompted hello"
            first = False
            continue
        request_id = frame["requestId"]
        assert frame["kind"] in ("progress", "result", "error"), (
            "worker must not emit kind " + str(frame["kind"])
        )
        assert request_id not in seen_result, "no frame may follow a result frame"
        seq = frame["seq"]
        assert seq >= 0
        if request_id in last_seq:
            assert seq > last_seq[request_id], "seq must strictly increase per requestId"
        else:
            assert seq == 0, "the first frame of a request must carry seq 0"
        last_seq[request_id] = seq
        if frame["kind"] == "progress":
            assert frame["completed"] <= frame["total"], "completed must never exceed total"
        elif frame["kind"] == "result":
            seen_result.add(request_id)


class WorkerProc:
    """A real worker subprocess driven line by line over pipes."""

    def __init__(self) -> None:
        env = dict(os.environ)
        existing = env.get("PYTHONPATH")
        env["PYTHONPATH"] = str(SRC) if not existing else str(SRC) + os.pathsep + existing
        self.proc = subprocess.Popen(
            [sys.executable, "-m", WORKER_MODULE],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self._stderr_chunks: list[bytes] = []
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        for chunk in iter(lambda: self.proc.stderr.read(4096), b""):
            self._stderr_chunks.append(chunk)

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def send(self, obj: dict[str, Any]) -> None:
        self.send_raw(encode(obj))

    def read_line(self) -> bytes:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        assert line, "worker stdout closed before a frame arrived"
        assert line.endswith(b"\n"), "frames are written with exactly one trailing newline"
        return line[:-1]

    def read_frame(self) -> dict[str, Any]:
        return json.loads(self.read_line().decode("utf-8"))

    def read_until_terminal(self, request_id: str) -> list[dict[str, Any]]:
        frames: list[dict[str, Any]] = []
        while True:
            frame = self.read_frame()
            frames.append(frame)
            if frame.get("requestId") == request_id and frame.get("kind") in ("result", "error"):
                return frames

    def close_stdin(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()

    def wait(self, timeout: float = 30.0) -> int:
        code = self.proc.wait(timeout=timeout)
        self._stderr_thread.join(timeout=5.0)
        return code

    def stderr_text(self) -> str:
        return b"".join(self._stderr_chunks).decode("utf-8", errors="replace")

    def terminate(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()

    def __enter__(self) -> "WorkerProc":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.terminate()
        try:
            self.proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5.0)
        self._stderr_thread.join(timeout=5.0)
