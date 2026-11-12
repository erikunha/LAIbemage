"""Frame constants, builders and validators for visionlens.worker.v1.

The envelope set and every field are frozen; the tracked statements live in
docs/vnext/contracts/proposed/worker-request.v1.schema.json and
docs/vnext/contracts/proposed/worker-event.v1.schema.json. A frame is one
UTF-8 JSON object per line, written with exactly one trailing newline.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Mapping

from .errors import ErrorCode, WorkerError, is_retryable

PROTOCOL = "visionlens.worker.v1"
PROTOCOL_VERSION = "1.0.0"
CONTRACT_VERSION = "1.0.0"
PROTOCOL_MAJOR = 1
CONTRACT_MAJOR = 1

#: Default maximum frame size in bytes (1 MiB), negotiable in the handshake.
DEFAULT_MAX_FRAME_BYTES = 1048576

FRAME_KINDS = ("hello", "request", "progress", "result", "error", "cancel")

#: The five operation codes frozen for v1.
OPERATIONS = (
    "vision.embed",
    "vision.predict",
    "dataset.audit",
    "eval.run",
    "model.train",
)

_SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
_REQUEST_KEYS = frozenset(
    {
        "protocol",
        "kind",
        "requestId",
        "operation",
        "contractVersion",
        "workspaceId",
        "params",
        "budget",
    }
)
_BUDGET_REQUIRED_KEYS = frozenset({"maxSeconds", "maxUsdMicro"})
_BUDGET_OPTIONAL_KEYS = frozenset({"maxTokens"})
_HELLO_REQUIRED_KEYS = frozenset({"protocol", "kind", "protocolVersion", "contractVersion"})
_HELLO_OPTIONAL_KEYS = frozenset({"maxFrameBytes"})
_CANCEL_KEYS = frozenset({"protocol", "kind", "requestId"})


def protocol_major(version: str) -> int:
    """Return the major component of a semantic version string."""
    return int(version.split(".", 1)[0])


# ---------------------------------------------------------------------------
# Frame builders. Field order matches the frozen examples byte for byte.
# ---------------------------------------------------------------------------


def hello_frame(
    *,
    supported_operations: tuple[str, ...],
    capabilities: Mapping[str, object],
    max_frame_bytes: int,
) -> dict[str, object]:
    """Build the worker hello frame, the first frame of every session."""
    return {
        "protocol": PROTOCOL,
        "kind": "hello",
        "protocolVersion": PROTOCOL_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "supportedOperations": list(supported_operations),
        "capabilities": dict(capabilities),
        "maxFrameBytes": max_frame_bytes,
    }


def progress_frame(request_id: str, seq: int, completed: int, total: int) -> dict[str, object]:
    """Build a progress frame for one request."""
    return {
        "protocol": PROTOCOL,
        "kind": "progress",
        "requestId": request_id,
        "seq": seq,
        "completed": completed,
        "total": total,
    }


def result_frame(request_id: str, seq: int, result: Mapping[str, object]) -> dict[str, object]:
    """Build the terminal result frame for one request."""
    return {
        "protocol": PROTOCOL,
        "kind": "result",
        "requestId": request_id,
        "seq": seq,
        "result": dict(result),
    }


def error_frame(request_id: str, seq: int, code: ErrorCode, message: str) -> dict[str, object]:
    """Build a terminal error frame carrying one frozen code."""
    return {
        "protocol": PROTOCOL,
        "kind": "error",
        "requestId": request_id,
        "seq": seq,
        "code": code.value,
        "message": message,
        "retryable": is_retryable(code),
    }


def channel_error_frame(code: ErrorCode, message: str) -> dict[str, object]:
    """Build an error frame for a failure whose request id could not be recovered.

    The wire contract carries requestId only when the id could be recovered;
    an empty id fails the ratified schema, so this frame omits both requestId
    and seq and carries protocol, kind, code, message and retryable only.
    """
    return {
        "protocol": PROTOCOL,
        "kind": "error",
        "code": code.value,
        "message": message,
        "retryable": is_retryable(code),
    }


def encode_frame(frame: Mapping[str, object]) -> bytes:
    """Serialize a frame as one compact UTF-8 JSON line with one newline."""
    text = json.dumps(frame, separators=(",", ":"), ensure_ascii=True)
    return (text + "\n").encode("utf-8")


# ---------------------------------------------------------------------------
# Validators. Every refusal raises WorkerError with MALFORMED_FRAME except
# where a different frozen code is named in the message.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Budget:
    """The budget block of a request, frozen to three known fields."""

    max_seconds: int
    max_usd_micro: int
    max_tokens: int | None


@dataclass(frozen=True)
class RequestFrame:
    """A validated request frame."""

    request_id: str
    operation: str
    contract_version: str
    workspace_id: str
    params: dict[str, object]
    budget: Budget


@dataclass(frozen=True)
class HostHello:
    """A validated host hello frame."""

    protocol_version: str
    contract_version: str
    max_frame_bytes: int | None


def _report_missing_and_unknown(
    obj: Mapping[str, object], required: frozenset[str], optional: frozenset[str], label: str
) -> None:
    keys = set(obj)
    missing = sorted(required - keys)
    unknown = sorted(keys - required - optional)
    if missing:
        raise WorkerError(
            ErrorCode.MALFORMED_FRAME,
            label + " misses required field(s): " + ", ".join(missing),
        )
    if unknown:
        raise WorkerError(
            ErrorCode.MALFORMED_FRAME,
            label + " has unknown field(s): " + ", ".join(unknown),
        )


def _require_semver(value: object, field: str) -> str:
    if not isinstance(value, str) or not _SEMVER_RE.match(value):
        raise WorkerError(
            ErrorCode.MALFORMED_FRAME,
            field + " must be a semantic version like 1.0.0, got '" + str(value) + "'",
        )
    return value


def _require_int(
    value: object,
    field: str,
    minimum: int,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise WorkerError(ErrorCode.MALFORMED_FRAME, field + " must be an integer")
    if value < minimum or (maximum is not None and value > maximum):
        if maximum is None:
            expected = str(minimum) + " or greater"
        else:
            expected = "between " + str(minimum) + " and " + str(maximum)
        raise WorkerError(ErrorCode.MALFORMED_FRAME, field + " must be " + expected)
    return value


def _validate_budget(obj: object) -> Budget:
    if not isinstance(obj, dict):
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "budget must be an object")
    _report_missing_and_unknown(
        obj, _BUDGET_REQUIRED_KEYS, _BUDGET_OPTIONAL_KEYS, "request budget"
    )
    max_seconds = _require_int(obj["maxSeconds"], "budget.maxSeconds", 1, 86400)
    max_usd_micro = _require_int(obj["maxUsdMicro"], "budget.maxUsdMicro", 0)
    max_tokens: int | None = None
    if "maxTokens" in obj:
        max_tokens = _require_int(obj["maxTokens"], "budget.maxTokens", 0)
    return Budget(max_seconds, max_usd_micro, max_tokens)


def validate_request_frame(obj: Mapping[str, object]) -> RequestFrame:
    """Validate a request frame shape, refusing anything unknown or missing."""
    _report_missing_and_unknown(obj, _REQUEST_KEYS, frozenset(), "request")
    request_id = obj["requestId"]
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise WorkerError(
            ErrorCode.MALFORMED_FRAME,
            "requestId must be a string of 1 to 128 characters",
        )
    operation = obj["operation"]
    if not isinstance(operation, str) or not operation:
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "operation must be a non-empty string")
    contract_version = _require_semver(obj["contractVersion"], "contractVersion")
    workspace_id = obj["workspaceId"]
    if not isinstance(workspace_id, str) or not workspace_id:
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "workspaceId must be a non-empty string")
    params = obj["params"]
    if not isinstance(params, dict):
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "params must be an object")
    budget = _validate_budget(obj["budget"])
    return RequestFrame(
        request_id=request_id,
        operation=operation,
        contract_version=contract_version,
        workspace_id=workspace_id,
        params=params,
        budget=budget,
    )


def validate_host_hello(obj: Mapping[str, object]) -> HostHello:
    """Validate the host hello frame that answers the worker hello."""
    _report_missing_and_unknown(obj, _HELLO_REQUIRED_KEYS, _HELLO_OPTIONAL_KEYS, "host hello")
    if obj["kind"] != "hello":
        raise WorkerError(
            ErrorCode.MALFORMED_FRAME,
            "host hello frame must carry kind 'hello'",
        )
    protocol_version = _require_semver(obj["protocolVersion"], "protocolVersion")
    contract_version = _require_semver(obj["contractVersion"], "contractVersion")
    max_frame_bytes: int | None = None
    if "maxFrameBytes" in obj:
        max_frame_bytes = _require_int(obj["maxFrameBytes"], "maxFrameBytes", 1)
    return HostHello(protocol_version, contract_version, max_frame_bytes)


def validate_cancel_frame(obj: Mapping[str, object]) -> str:
    """Validate a cancel frame and return its requestId."""
    _report_missing_and_unknown(obj, _CANCEL_KEYS, frozenset(), "cancel")
    if obj["kind"] != "cancel":
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "cancel frame must carry kind 'cancel'")
    request_id = obj["requestId"]
    if not isinstance(request_id, str) or not request_id:
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "requestId must be a non-empty string")
    return request_id
