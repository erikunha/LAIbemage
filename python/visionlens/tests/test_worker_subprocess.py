"""End-to-end sessions over real subprocess pipes."""

from __future__ import annotations

import json
import time

from helpers import SRC  # noqa: F401  (path setup)
from helpers import WorkerProc, host_hello, request

from visionlens import protocol


def embed(request_id: str, images: list[str], model: str = "siglip2-base") -> dict:
    return request(request_id, "vision.embed", {"images": images, "model": model})


def cancel(request_id: str) -> dict:
    return {"protocol": protocol.PROTOCOL, "kind": "cancel", "requestId": request_id}


def test_full_session_over_real_pipes():
    with WorkerProc() as worker:
        hello = worker.read_frame()
        assert hello["kind"] == "hello"
        assert hello["protocolVersion"] == "1.0.0"
        assert hello["supportedOperations"] == list(protocol.OPERATIONS)
        assert hello["maxFrameBytes"] == 1048576

        worker.send(host_hello())
        worker.send(embed("r-1", ["golden-alpha", "golden-beta"]))
        frames = worker.read_until_terminal("r-1")
        result = frames[-1]
        assert result["kind"] == "result"
        assert result["seq"] == 3
        assert [f["seq"] for f in frames] == [0, 1, 2, 3]
        assert all(f["completed"] <= f["total"] for f in frames[:-1])
        payload = result["result"]
        assert payload["count"] == 2
        assert payload["dimension"] == 768
        assert all(len(v) == 768 for v in payload["vectors"])

        worker.send_raw(b"{not json\n")
        error = worker.read_frame()
        assert error["kind"] == "error"
        assert error["code"] == "MALFORMED_FRAME"
        assert "requestId" not in error
        assert "seq" not in error

        worker.send(embed("r-2", ["other"], model="clip-vit-b32"))
        served = worker.read_until_terminal("r-2")
        assert served[-1]["kind"] == "result"
        assert served[-1]["result"]["dimension"] == 512

        worker.close_stdin()
        assert worker.wait() == 0
        stderr = worker.stderr_text()
        assert stderr.strip(), "the worker must log to stderr"
        assert "handshake complete" in stderr


def test_handshake_gate_over_real_pipes():
    with WorkerProc() as worker:
        assert worker.read_frame()["kind"] == "hello"
        worker.send(embed("r-1", ["a"]))
        refusal = worker.read_frame()
        assert refusal["kind"] == "error"
        assert refusal["code"] == "UNSUPPORTED_PROTOCOL"
        assert refusal["requestId"] == "r-1"
        # the worker stays alive and completes the handshake afterwards
        worker.send(host_hello())
        worker.send(embed("r-2", ["a"]))
        assert worker.read_until_terminal("r-2")[-1]["kind"] == "result"
        worker.close_stdin()
        assert worker.wait() == 0


def test_cancel_ladder_over_real_pipes():
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello())
        worker.send(request("r-1", "model.train", {"dataset": "ds", "recipe": "slow"}))
        first = worker.read_frame()
        assert first["kind"] == "progress"
        assert first["requestId"] == "r-1"

        worker.send(cancel("r-1"))
        frames = worker.read_until_terminal("r-1")
        terminal_frame = frames[-1]
        assert terminal_frame["kind"] == "error"
        assert terminal_frame["code"] == "CANCELLED"
        assert terminal_frame["retryable"] is False
        assert all(f["kind"] != "result" for f in frames)

        # the worker keeps serving after a cancellation
        worker.send(embed("r-2", ["a"]))
        assert worker.read_until_terminal("r-2")[-1]["kind"] == "result"
        worker.close_stdin()
        assert worker.wait() == 0
        assert "cancellation requested" in worker.stderr_text()


def test_cancel_after_result_is_a_no_op():
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello())
        worker.send(request("r-1", "model.train", {"dataset": "ds", "recipe": "quick"}))
        frames = worker.read_until_terminal("r-1")
        assert frames[-1]["kind"] == "result"

        worker.send(cancel("r-1"))
        worker.send(embed("r-2", ["a"]))
        while True:
            frame = worker.read_frame()
            assert not (frame["requestId"] == "r-1" and frame["kind"] == "error"), (
                "a cancel after the result must not produce an error frame"
            )
            if frame["requestId"] == "r-2" and frame["kind"] == "result":
                break
        worker.close_stdin()
        assert worker.wait() == 0
        assert "no-op" in worker.stderr_text()


def test_deadline_is_enforced_over_real_pipes():
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello())
        started = time.monotonic()
        worker.send(
            request(
                "r-1",
                "model.train",
                {"dataset": "ds", "recipe": "slow"},
                max_seconds=1,
            )
        )
        frames = worker.read_until_terminal("r-1")
        elapsed = time.monotonic() - started
        assert frames[-1]["kind"] == "error"
        assert frames[-1]["code"] == "DEADLINE_EXCEEDED"
        assert elapsed >= 1.0
        assert elapsed < 4.0

        worker.send(embed("r-2", ["a"]))
        assert worker.read_until_terminal("r-2")[-1]["kind"] == "result"
        worker.close_stdin()
        assert worker.wait() == 0


def test_default_frame_limit_is_enforced_over_real_pipes():
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello())
        payload = b"x" * (2 * 1024 * 1024)
        for offset in range(0, len(payload), 65536):
            worker.send_raw(payload[offset : offset + 65536])
        worker.send_raw(b"\n")
        error = worker.read_frame()
        assert error["kind"] == "error"
        assert error["code"] == "MALFORMED_FRAME"
        assert "exceeds" in error["message"]

        worker.send(embed("r-1", ["a"]))
        assert worker.read_until_terminal("r-1")[-1]["kind"] == "result"
        worker.close_stdin()
        assert worker.wait() == 0


def test_negotiated_frame_limit_is_enforced_over_real_pipes():
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello(max_frame_bytes=256))
        long_request = embed("r-1", ["a"], model="siglip2-base")
        long_request["workspaceId"] = "w" * 300
        worker.send(long_request)
        error = worker.read_frame()
        assert error["code"] == "MALFORMED_FRAME"
        assert "256" in error["message"]

        worker.send(embed("r-2", ["a"]))
        assert worker.read_until_terminal("r-2")[-1]["kind"] == "result"
        worker.close_stdin()
        assert worker.wait() == 0


def test_sigterm_is_graceful_and_emits_no_result():
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello())
        worker.send(request("r-1", "model.train", {"dataset": "ds", "recipe": "slow"}))
        first = worker.read_frame()
        assert first["kind"] == "progress"

        worker.terminate()
        tail: list[bytes] = []
        assert worker.proc.stdout is not None
        for line in iter(worker.proc.stdout.readline, b""):
            tail.append(line)
        code = worker.wait()
        assert code == 0
        parsed = [json.loads(line) for line in tail]
        assert all(f["protocol"] == protocol.PROTOCOL for f in parsed), (
            "stdout must carry frames only, even while shutting down"
        )
        r1 = [f for f in parsed if f.get("requestId") == "r-1"]
        assert all(f["kind"] != "result" for f in r1)
        terminals = [f for f in r1 if f["kind"] == "error"]
        assert len(terminals) == 1
        assert terminals[0]["code"] == "CANCELLED"


def test_stdout_carries_frames_only_while_stderr_carries_logs():
    with WorkerProc() as worker:
        worker.read_frame()
        worker.send(host_hello())
        worker.send(embed("r-1", ["a", "b"]))
        # wait for the terminal before injecting the malformed line, so the
        # error frame cannot interleave with the request's frames
        worker.read_until_terminal("r-1")
        worker.send_raw(b"{not json\n")
        error = worker.read_frame()
        assert error["code"] == "MALFORMED_FRAME"
        worker.close_stdin()
        assert worker.wait() == 0
        stderr = worker.stderr_text()
        assert "request r-1" in stderr
