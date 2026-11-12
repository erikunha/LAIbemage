"""Spec 018 SC-006: the pack example payloads through the Python side.

The pack under ``docs/vnext/contracts/proposed`` is read-only input. Each
example is loaded from disk at run time (paths resolve from this file's
location) and run through the Python protocol surface, mirroring the
TypeScript test ``packages/contracts/tests/worker/pack-examples.test.ts``:
the request example goes through the inbound request validator, and the two
worker-emitted examples are checked the way the worker's own tests check
emitted frames (frozen builder shape plus the envelope invariants), because
the Python side has no inbound validator for frames the worker emits; the
host validates those in TypeScript. That gap is stated here rather than
papered over with an invented validator. Every payload value is pinned, so
an edit to a pack file fails here just as it fails the TypeScript test.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from helpers import SRC  # noqa: F401  (path setup)

from visionlens import protocol

PACK_EXAMPLES = (
    Path(__file__).resolve().parents[3]
    / "docs"
    / "vnext"
    / "contracts"
    / "proposed"
    / "examples"
)

pytestmark = pytest.mark.skipif(
    not PACK_EXAMPLES.is_dir(), reason="the docs/vnext pack examples are absent"
)


def load_example(name: str) -> dict[str, object]:
    return json.loads((PACK_EXAMPLES / name).read_text(encoding="utf-8"))


def test_request_example_validates_through_the_request_validator():
    frame = protocol.validate_request_frame(load_example("worker-request.example.json"))
    assert frame.request_id == "req_demo_001"
    assert frame.operation == "vision.embed"
    assert frame.contract_version == "1.0.0"
    assert frame.workspace_id == "local"
    assert frame.params == {
        "snapshotId": "snap_demo_001",
        "encoder": "siglip2-base",
        "assetsRef": "assetset_demo_001",
    }
    assert frame.budget.max_seconds == 120
    assert frame.budget.max_usd_micro == 0
    assert frame.budget.max_tokens == 0


def test_progress_example_matches_the_frozen_emitted_envelope():
    payload = load_example("worker-progress.example.json")
    assert payload == {
        "protocol": protocol.PROTOCOL,
        "kind": "progress",
        "requestId": "req_demo_001",
        "seq": 0,
        "completed": 2,
        "total": 5,
    }, "the pack progress example must be exactly the frame the worker emits"
    # the envelope invariants the worker's own tests assert over emitted frames
    assert payload["seq"] >= 0
    assert payload["completed"] <= payload["total"]
    # the emitted frame survives the worker's own wire encoding unchanged
    assert json.loads(protocol.encode_frame(payload)) == payload


def test_result_example_is_the_frozen_envelope_plus_the_proposal_only_status():
    payload = load_example("worker-result.example.json")
    assert payload["protocol"] == protocol.PROTOCOL
    assert payload["kind"] == "result"
    assert payload["requestId"] == "req_demo_001"
    assert payload["seq"] == 1
    assert payload["result"] == {
        "embeddingRunId": "embed_demo_001",
        "count": 5,
        "dimensions": 768,
        "dtype": "float32",
        "artifactSha256": "0" * 64,
        "source": "synthetic-example-not-a-real-run",
    }
    # Gap, stated plainly: the ratified result envelope is protocol, kind,
    # requestId, seq and result. The pack proposal and spec 018 FR-005 add a
    # top-level status fixed to "succeeded"; the ratified schemas on both
    # sides omit it, so the TypeScript event schema rejects this payload
    # unchanged with a single unrecognized-key issue for "status". These
    # assertions pin that drift: the difference between the example and the
    # envelope the Python worker emits is exactly the status field, nothing
    # else, and setting it aside leaves a frame that round-trips the wire.
    emitted = protocol.result_frame("req_demo_001", 1, payload["result"])
    assert set(payload) - set(emitted) == {"status"}
    assert set(emitted) - set(payload) == set()
    without_status = {key: value for key, value in payload.items() if key != "status"}
    assert json.loads(protocol.encode_frame(without_status)) == without_status
