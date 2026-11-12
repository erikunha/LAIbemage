"""Fixture python worker for the optional interpreter-seam test.

Speaks the frozen visionlens.worker.v1 protocol: frames to stdout, one JSON
object per line, nothing else on stdout. Standard library only.
"""

import json
import sys
from typing import Any, Dict

PROTOCOL = "visionlens.worker.v1"


def send(frame: Dict[str, Any]) -> None:
    """Write one frame to stdout: exactly one JSON object plus one newline."""
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def main() -> None:
    """Serve the echo protocol until stdin closes."""
    send(
        {
            "protocol": PROTOCOL,
            "kind": "hello",
            "protocolVersion": "1.0.0",
            "contractVersion": "1.0.0",
            "supportedOperations": ["vision.embed"],
            "capabilities": {"device": "cpu", "extras": [], "models": []},
            "maxFrameBytes": 1048576,
        }
    )
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            frame = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if frame.get("kind") == "request":
            send(
                {
                    "protocol": PROTOCOL,
                    "kind": "result",
                    "requestId": frame["requestId"],
                    "seq": 0,
                    "result": {
                        "operation": frame["operation"],
                        "params": frame["params"],
                        "interpreter": "python",
                    },
                }
            )


if __name__ == "__main__":
    main()
