"""The frozen error vocabulary and the request validation surface."""

from __future__ import annotations

import json

import pytest
from helpers import SRC  # noqa: F401  (path setup)
from helpers import request

from visionlens import protocol
from visionlens.errors import ErrorCode, WorkerError, is_retryable

# The frozen table: code -> retryable.
FROZEN_VOCABULARY = {
    "UNSUPPORTED_PROTOCOL": False,
    "MISSING_EXTRA": False,
    "MALFORMED_FRAME": False,
    "PROTOCOL_MISMATCH": False,
    "UNSUPPORTED_OPERATION": False,
    "CANCELLED": False,
    "DEADLINE_EXCEEDED": False,
    "BUDGET_EXCEEDED": False,
    "WORKER_CRASHED": True,
    "PROVIDER_UNAVAILABLE": True,
}


def test_error_vocabulary_is_exactly_the_frozen_table():
    assert {code.value: flag for code, flag in
            ((c, is_retryable(c)) for c in ErrorCode)} == FROZEN_VOCABULARY
    assert len(ErrorCode) == 10


@pytest.mark.parametrize("code,expected", sorted(FROZEN_VOCABULARY.items()))
def test_every_code_carries_its_frozen_retryable_flag(code: str, expected: bool):
    error = WorkerError(ErrorCode(code), "message")
    assert error.retryable is expected
    assert error.code.value == code


def test_hello_frame_matches_the_frozen_shape():
    frame = protocol.hello_frame(
        supported_operations=("vision.embed",),
        capabilities={"device": "cpu", "extras": [], "models": []},
        max_frame_bytes=1048576,
    )
    assert frame == {
        "protocol": "visionlens.worker.v1",
        "kind": "hello",
        "protocolVersion": "1.0.0",
        "contractVersion": "1.0.0",
        "supportedOperations": ["vision.embed"],
        "capabilities": {"device": "cpu", "extras": [], "models": []},
        "maxFrameBytes": 1048576,
    }


def test_encode_frame_is_compact_with_one_trailing_newline():
    encoded = protocol.encode_frame(protocol.progress_frame("r-1", 0, 1, 2))
    assert encoded == (
        b'{"protocol":"visionlens.worker.v1","kind":"progress","requestId":"r-1",'
        b'"seq":0,"completed":1,"total":2}\n'
    )
    assert encoded.count(b"\n") == 1


def test_validate_request_accepts_the_frozen_example():
    frame = protocol.validate_request_frame(
        json.loads(
            '{"protocol":"visionlens.worker.v1","kind":"request","requestId":"r-1",'
            '"operation":"vision.embed","contractVersion":"1.0.0","workspaceId":"ws-1",'
            '"params":{},"budget":{"maxSeconds":60,"maxUsdMicro":0}}'
        )
    )
    assert frame.request_id == "r-1"
    assert frame.operation == "vision.embed"
    assert frame.budget.max_seconds == 60
    assert frame.budget.max_usd_micro == 0
    assert frame.budget.max_tokens is None


def test_budget_accepts_the_boundaries():
    for max_seconds in (1, 86400):
        frame = protocol.validate_request_frame(
            request("r", "vision.embed", {}, max_seconds=max_seconds)
        )
        assert frame.budget.max_seconds == max_seconds
    frame = protocol.validate_request_frame(
        request("r", "vision.embed", {}, max_tokens=0)
    )
    assert frame.budget.max_tokens == 0


def _assert_malformed(obj: dict, needle: str) -> None:
    with pytest.raises(WorkerError) as excinfo:
        protocol.validate_request_frame(obj)
    assert excinfo.value.code is ErrorCode.MALFORMED_FRAME
    assert needle in excinfo.value.message


@pytest.mark.parametrize(
    "field",
    [
        "protocol",
        "kind",
        "requestId",
        "operation",
        "contractVersion",
        "workspaceId",
        "params",
        "budget",
    ],
)
def test_request_refuses_a_missing_required_field(field: str):
    obj = request("r-1", "vision.embed", {})
    del obj[field]
    _assert_malformed(obj, field)


def test_request_refuses_an_unknown_top_level_field():
    obj = request("r-1", "vision.embed", {})
    obj["priority"] = "high"
    _assert_malformed(obj, "priority")


@pytest.mark.parametrize("request_id", ["", "x" * 129, 7])
def test_request_refuses_a_bad_request_id(request_id):
    _assert_malformed(request(request_id, "vision.embed", {}), "requestId")


@pytest.mark.parametrize("contract_version", ["1.0", "v1.0.0", "1.0.0-rc1", 1])
def test_request_refuses_a_bad_contract_version(contract_version):
    _assert_malformed(
        request("r-1", "vision.embed", {}, contract_version=contract_version),  # type: ignore[arg-type]
        "contractVersion",
    )


def test_request_refuses_a_bad_workspace_and_params():
    _assert_malformed(request("r-1", "vision.embed", {}, workspace_id=""), "workspaceId")
    obj = request("r-1", "vision.embed", {})
    obj["params"] = ["not", "an", "object"]
    _assert_malformed(obj, "params")


@pytest.mark.parametrize(
    "budget",
    [
        {"maxUsdMicro": 0},
        {"maxSeconds": 60},
        {"maxSeconds": 60, "maxUsdMicro": 0, "maxTokens": 5, "extra": 1},
        {"maxSeconds": 0, "maxUsdMicro": 0},
        {"maxSeconds": 86401, "maxUsdMicro": 0},
        {"maxSeconds": "60", "maxUsdMicro": 0},
        {"maxSeconds": True, "maxUsdMicro": 0},
        {"maxSeconds": 60, "maxUsdMicro": -1},
        {"maxSeconds": 60, "maxUsdMicro": 0, "maxTokens": -2},
    ],
)
def test_request_refuses_a_bad_budget(budget: dict):
    obj = request("r-1", "vision.embed", {})
    obj["budget"] = budget
    _assert_malformed(obj, "budget")


def test_host_hello_validation():
    from helpers import host_hello

    hello = protocol.validate_host_hello(host_hello(max_frame_bytes=512))
    assert hello.protocol_version == "1.0.0"
    assert hello.max_frame_bytes == 512
    with pytest.raises(WorkerError):
        protocol.validate_host_hello({"protocol": protocol.PROTOCOL, "kind": "hello"})
    with pytest.raises(WorkerError):
        protocol.validate_host_hello(
            {**host_hello(), "protocolVersion": "one-dot-two"}
        )
    with pytest.raises(WorkerError):
        protocol.validate_host_hello({**host_hello(), "maxFrameBytes": 0})


def test_cancel_frame_validation():
    frame = {
        "protocol": protocol.PROTOCOL,
        "kind": "cancel",
        "requestId": "r-1",
    }
    assert protocol.validate_cancel_frame(frame) == "r-1"
    frame["extra"] = True
    with pytest.raises(WorkerError):
        protocol.validate_cancel_frame(frame)


def test_protocol_major_parses_only_the_major():
    assert protocol.protocol_major("1.24.3") == 1
    assert protocol.protocol_major("12.0.0") == 12


def test_operations_are_the_frozen_five():
    assert protocol.OPERATIONS == (
        "vision.embed",
        "vision.predict",
        "dataset.audit",
        "eval.run",
        "model.train",
    )
    assert protocol.FRAME_KINDS == (
        "hello",
        "request",
        "progress",
        "result",
        "error",
        "cancel",
    )
    assert protocol.DEFAULT_MAX_FRAME_BYTES == 1048576
