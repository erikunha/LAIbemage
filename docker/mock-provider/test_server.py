"""Tests for the deterministic mock provider (docker/mock-provider/server.py).

Run: python3 -m pytest docker/mock-provider/test_server.py -q

Everything is hermetic: the functions are driven directly and one end-to-end
case uses a real server on an ephemeral port. No network, no keys.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server as mock  # noqa: E402 (path insert above is the point)

CHAT_BODY = {
    "model": "gpt-4o",
    "messages": [
        {"role": "system", "content": "You label images."},
        {"role": "user", "content": "A photo of a burned PCB component."},
    ],
}


def test_chat_completion_is_deterministic() -> None:
    first = mock.chat_completion_response(CHAT_BODY)
    second = mock.chat_completion_response(CHAT_BODY)
    assert first == second
    assert first["object"] == "chat.completion"
    assert first["created"] == mock.FIXED_CREATED
    content = json.loads(first["choices"][0]["message"]["content"])
    assert set(content) == {"labelKey", "confidence"}
    assert 0.5 <= content["confidence"] <= 0.99


def test_chat_completion_is_input_sensitive() -> None:
    changed = json.loads(json.dumps(CHAT_BODY))
    changed["messages"][1]["content"] = "A photo of a pristine PCB component."
    a = mock.chat_completion_response(CHAT_BODY)
    b = mock.chat_completion_response(changed)
    assert a["id"] != b["id"]
    assert a["choices"][0]["message"]["content"] != b["choices"][0]["message"]["content"]


def test_embeddings_are_deterministic_and_sensitive() -> None:
    a = mock.embeddings_response({"model": "m", "input": ["alpha", "beta"]})
    b = mock.embeddings_response({"model": "m", "input": ["alpha", "beta"]})
    assert a == b
    assert len(a["data"]) == 2
    assert all(len(item["embedding"]) == mock.EMBEDDING_DIM for item in a["data"])
    c = mock.embeddings_response({"model": "m", "input": ["alpha", "gamma"]})
    assert a["data"][0]["embedding"] == c["data"][0]["embedding"]
    assert a["data"][1]["embedding"] != c["data"][1]["embedding"]


def test_behavior_cycle_scripts_and_recovers() -> None:
    cycle = mock.BehaviorCycle("429,500,503,ok")
    assert [cycle.next() for _ in range(5)] == ["429", "500", "503", "ok", "429"]
    assert mock.BehaviorCycle("").next() == "ok"


def test_error_response_shape() -> None:
    body = mock.error_response(429, "scripted_429")
    assert body["error"]["code"] == "scripted_429"


def _start_server(script: str) -> tuple[ThreadingHTTPServer, str]:
    saved = mock.CYCLE
    mock.CYCLE = mock.BehaviorCycle(script)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), mock.MockHandler)

    def run() -> None:
        httpd.serve_forever(poll_interval=0.05)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    def restore() -> None:
        mock.CYCLE = saved
        httpd.shutdown()
        httpd.server_close()

    host, port = httpd.server_address
    return httpd, f"http://{host}:{port}", restore


def test_end_to_end_ok_then_429_then_ok() -> None:
    _, base, restore = _start_server("ok,429,ok")
    try:
        # 1: normal deterministic answer
        req = urllib.request.Request(
            base + "/v1/chat/completions",
            data=json.dumps(CHAT_BODY).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            assert resp.status == 200
            first = json.loads(resp.read().decode("utf-8"))
        assert first["created"] == mock.FIXED_CREATED

        # 2: scripted 429 surfaces as an OpenAI-shaped error body
        try:
            urllib.request.urlopen(req, timeout=5)
            raise AssertionError("expected HTTP 429")
        except urllib.error.HTTPError as err:
            assert err.code == 429
            assert json.loads(err.read().decode("utf-8"))["error"]["code"] == "scripted_429"

        # 3: the cycle recovers to 200 and the answer is byte-identical to (1)
        with urllib.request.urlopen(req, timeout=5) as resp:
            assert resp.status == 200
            assert json.loads(resp.read().decode("utf-8")) == first

        # health and model list
        with urllib.request.urlopen(base + "/healthz", timeout=5) as resp:
            assert json.loads(resp.read().decode("utf-8")) == {"ok": True}
        with urllib.request.urlopen(base + "/v1/models", timeout=5) as resp:
            assert json.loads(resp.read().decode("utf-8"))["data"][0]["id"] == mock.DEFAULT_MODEL
    finally:
        restore()


def test_end_to_end_delay_adds_latency() -> None:
    _, base, restore = _start_server("delay:120")
    try:
        req = urllib.request.Request(
            base + "/v1/embeddings",
            data=json.dumps({"model": "m", "input": ["x"]}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        started = time.monotonic()
        with urllib.request.urlopen(req, timeout=5) as resp:
            assert resp.status == 200
            json.loads(resp.read().decode("utf-8"))
        assert time.monotonic() - started >= 0.1
    finally:
        restore()
