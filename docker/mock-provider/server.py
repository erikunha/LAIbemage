"""Deterministic OpenAI-compatible mock provider.

Serves the three endpoints the repository's provider layer talks to when
``OPENAI_BASE_URL`` points here: ``POST /v1/chat/completions``,
``POST /v1/embeddings`` and ``GET /v1/models``. Responses are a pure function
of the request body, so the same request always produces the same bytes (the
``created`` field is a fixed constant, not a clock).

Failure scripting is server-side, because real SDK clients cannot attach
custom headers: the ``MOCK_SCRIPT`` environment variable holds a comma
separated cycle of behaviors applied to consecutive requests, for example
``MOCK_SCRIPT=429,ok`` answers 429 once then succeeds. Behaviors:

- ``ok``: normal deterministic response
- ``429``, ``500``, ``503``: that status with an OpenAI-shaped error body
- ``delay:N``: sleep N milliseconds, then answer ``ok``

Standard library only, so the image stays tiny and needs no Node.

Usage: python server.py [--host 127.0.0.1] [--port 8080]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FIXED_CREATED = 1731638400  # 2024-11-15T00:00:00Z, constant for byte-identical responses
DEFAULT_MODEL = "mock-model-v1"
EMBEDDING_DIM = 8


def _digest(payload: object) -> str:
    """A stable hex digest of a JSON payload, independent of dict ordering."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _deterministic_embedding(seed: str) -> list[float]:
    """Derive a fixed small vector from a seed, in [-1, 1], no randomness."""
    raw = hashlib.sha256(seed.encode("utf-8")).digest()
    return [round((b / 127.5) - 1.0, 6) for b in raw[:EMBEDDING_DIM]]


def _deterministic_content(messages: list) -> str:
    """Derive a fixed labeling-style JSON answer from the prompt messages."""
    seed = _digest(messages)
    # Two hex nibbles drive the label choice and the confidence, so a changed
    # prompt changes the answer and the same prompt never does.
    first = int(seed[0], 16)
    second = int(seed[1], 16)
    labels = ["normal", "burn", "contamination", "misplacement"]
    label = labels[first % len(labels)]
    confidence = round(0.5 + (second / 255.0) * 0.49, 4)
    return json.dumps({"labelKey": label, "confidence": confidence}, sort_keys=True)


def chat_completion_response(body: dict) -> dict:
    prompt = body.get("messages", [])
    model = body.get("model", DEFAULT_MODEL)
    seed = _digest({"kind": "chat", "model": model, "messages": prompt})
    return {
        "id": f"chatcmpl-mock-{seed[:24]}",
        "object": "chat.completion",
        "created": FIXED_CREATED,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": _deterministic_content(prompt), "refusal": None},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 16, "completion_tokens": 8, "total_tokens": 24},
    }


def embeddings_response(body: dict) -> dict:
    inputs = body.get("input", "")
    if isinstance(inputs, str):
        inputs = [inputs]
    model = body.get("model", DEFAULT_MODEL)
    return {
        "object": "list",
        "data": [
            {
                "object": "embedding",
                "index": i,
                # Per item: each vector depends on its own input text and the
                # model, never on its neighbors, like a real embedding call.
                "embedding": _deterministic_embedding(_digest({"kind": "embedding", "model": model, "item": item, "index": i})),
            }
            for i, item in enumerate(inputs)
        ],
        "model": model,
        "usage": {"prompt_tokens": 8 * len(inputs), "total_tokens": 8 * len(inputs)},
    }


def error_response(status: int, code: str) -> dict:
    return {"error": {"message": f"mock provider scripted {code}", "type": code, "code": code}}


class BehaviorCycle:
    """Server-side scripted behavior: MOCK_SCRIPT=429,500,ok cycles forever."""

    def __init__(self, script: str) -> None:
        self.steps = [s.strip() for s in script.split(",") if s.strip()] or ["ok"]
        self.index = 0

    def next(self) -> str:
        step = self.steps[self.index % len(self.steps)]
        self.index += 1
        return step


CYCLE = BehaviorCycle("ok")  # replaced by the configured cycle in main()


class MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MockOpenAI/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        """Logs go to stderr in a compact single line, frames never do."""
        sys.stderr.write(("mock-provider " + self.address_string() + " " + (fmt % args) + "\n"))

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _apply(self, body: dict, responder) -> None:
        step = CYCLE.next()
        if step in ("429", "500", "503"):
            self._send(int(step), error_response(int(step), f"scripted_{step}"))
            return
        if step.startswith("delay:"):
            try:
                ms = int(step.split(":", 1)[1])
            except ValueError:
                ms = 100
            time.sleep(max(0, ms) / 1000.0)
        self._send(200, responder(body))

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path in ("/healthz", "/v1/models"):
            payload = (
                {"object": "list", "data": [{"object": "model", "id": DEFAULT_MODEL}]}
                if self.path == "/v1/models"
                else {"ok": True}
            )
            self._send(200, payload)
            return
        self._send(404, error_response(404, "not_found"))

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, error_response(400, "invalid_json"))
            return
        if self.path == "/v1/chat/completions":
            self._apply(body, chat_completion_response)
            return
        if self.path == "/v1/embeddings":
            self._apply(body, embeddings_response)
            return
        self._send(404, error_response(404, "not_found"))


def main(argv: list[str] | None = None) -> int:
    import os

    parser = argparse.ArgumentParser(description="Deterministic OpenAI-compatible mock provider")
    parser.add_argument("--host", default=os.environ.get("MOCK_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MOCK_PORT", "8080")))
    args = parser.parse_args(argv)

    global CYCLE
    CYCLE = BehaviorCycle(os.environ.get("MOCK_SCRIPT", "ok"))
    server = ThreadingHTTPServer((args.host, args.port), MockHandler)
    sys.stderr.write(f"mock provider listening on {args.host}:{args.port} script={CYCLE.steps}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
