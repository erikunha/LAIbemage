"""In-memory worker behavior: handshake, gate, errors, seq, cancel, limits."""

from __future__ import annotations

import pytest
from helpers import SRC  # noqa: F401  (path setup)
from helpers import assert_invariants, encode, frames_for, host_hello, request, run_session, terminal

from visionlens import protocol
from visionlens.errors import ErrorCode


def embed_request(request_id: str, images: list[str], model: str = "siglip2-base", **kwargs):
    return request(request_id, "vision.embed", {"images": images, "model": model}, **kwargs)


def test_first_frame_is_the_unprompted_hello():
    frames, _raw, code = run_session([])
    assert code == 0
    assert frames[0]["kind"] == "hello"
    assert frames[0]["protocolVersion"] == "1.0.0"
    assert frames[0]["contractVersion"] == "1.0.0"
    assert frames[0]["supportedOperations"] == list(protocol.OPERATIONS)
    assert frames[0]["capabilities"]["device"] == "cpu"
    assert frames[0]["capabilities"]["extras"] == []
    assert "siglip2-base" in frames[0]["capabilities"]["models"]
    assert frames[0]["maxFrameBytes"] == 1048576
    assert len(frames) == 1


def test_hello_advertises_installed_extras():
    frames, _raw, _code = run_session([], extras=["vision"])
    assert frames[0]["capabilities"]["extras"] == ["vision"]


def test_handshake_is_not_answered_with_a_frame():
    frames, _raw, _code = run_session([encode(host_hello()), encode(embed_request("r-1", ["a"]))])
    assert [f["kind"] for f in frames].count("hello") == 1
    assert_invariants(frames)
    assert terminal(frames, "r-1")["kind"] == "result"


def test_request_before_host_hello_is_refused_then_session_recovers():
    frames, _raw, _code = run_session(
        [
            encode(embed_request("r-1", ["a"])),
            encode(host_hello()),
            encode(embed_request("r-2", ["b"])),
        ]
    )
    refusal = frames[1]
    assert refusal["kind"] == "error"
    assert refusal["code"] == "UNSUPPORTED_PROTOCOL"
    assert refusal["retryable"] is False
    assert refusal["requestId"] == "r-1"
    assert refusal["seq"] == 0
    assert terminal(frames, "r-2")["kind"] == "result"
    assert_invariants(frames)


def test_host_hello_with_wrong_protocol_major_is_refused():
    frames, _raw, _code = run_session(
        [
            encode(host_hello(protocol_version="2.0.0")),
            encode(embed_request("r-1", ["a"])),
        ]
    )
    assert frames[1]["code"] == "UNSUPPORTED_PROTOCOL"
    # the handshake never completed, so the follow-up request is gated too
    assert frames[2]["code"] == "UNSUPPORTED_PROTOCOL"
    assert_invariants([frames[0]] + [f for f in frames[1:] if "requestId" in f])


def test_host_hello_with_wrong_contract_major_is_refused():
    frames, _raw, _code = run_session([encode(host_hello(contract_version="9.1.0"))])
    assert frames[1]["code"] == "UNSUPPORTED_PROTOCOL"


def test_request_with_foreign_protocol_major_gets_protocol_mismatch():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(embed_request("r-1", ["a"], wire_protocol="visionlens.worker.v2")),
        ]
    )
    error = terminal(frames, "r-1")
    assert error["code"] == "PROTOCOL_MISMATCH"
    assert "visionlens.worker.v2" in error["message"]


def test_request_with_wrong_contract_major_is_refused():
    frames, _raw, _code = run_session(
        [encode(host_hello()), encode(embed_request("r-1", ["a"], contract_version="2.0.0"))]
    )
    assert terminal(frames, "r-1")["code"] == "UNSUPPORTED_PROTOCOL"


def test_malformed_line_is_answered_and_the_next_request_is_served():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            b"{not json",
            encode(embed_request("r-1", ["a"])),
        ]
    )
    error = frames[1]
    assert error["kind"] == "error"
    assert error["code"] == "MALFORMED_FRAME"
    assert "requestId" not in error
    assert "seq" not in error
    assert terminal(frames, "r-1")["kind"] == "result"
    # channel error frames carry no requestId; the frozen seq rules apply
    # only to frames that carry one
    assert_invariants([frames[0]] + [f for f in frames[1:] if "requestId" in f])


def test_two_malformed_lines_each_get_an_error_frame_without_ids():
    frames, _raw, _code = run_session(
        [encode(host_hello()), b"{not json", b"also not json"]
    )
    errors = [f for f in frames if f["kind"] == "error"]
    assert len(errors) == 2
    assert all("requestId" not in f for f in errors)
    assert all("seq" not in f for f in errors)
    assert_invariants([frames[0]] + [f for f in frames[1:] if "requestId" in f])


def test_empty_line_is_answered_as_a_malformed_frame():
    frames, _raw, _code = run_session([encode(host_hello()), b"   "])
    assert frames[1]["code"] == "MALFORMED_FRAME"


def test_non_object_json_line_is_refused():
    frames, _raw, _code = run_session([encode(host_hello()), b'["a", "b"]'])
    assert frames[1]["code"] == "MALFORMED_FRAME"
    assert "requestId" not in frames[1]
    assert "seq" not in frames[1]


def test_frame_kind_not_accepted_from_the_host():
    for kind in ("progress", "result", "error"):
        frame = {
            "protocol": protocol.PROTOCOL,
            "kind": kind,
            "requestId": "r-1",
            "seq": 0,
        }
        frames, _raw, _code = run_session([encode(host_hello()), encode(frame)])
        assert frames[1]["code"] == "MALFORMED_FRAME", kind
        assert frames[1]["requestId"] == "r-1"


def test_duplicate_host_hello_is_refused():
    frames, _raw, _code = run_session(
        [encode(host_hello()), encode(host_hello())]
    )
    assert frames[1]["code"] == "MALFORMED_FRAME"
    assert "duplicate hello" in frames[1]["message"]


def test_unknown_operation_is_refused_with_the_id():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(request("r-1", "dataset.inspect", {})),
        ]
    )
    error = terminal(frames, "r-1")
    assert error["code"] == "UNSUPPORTED_OPERATION"
    assert "dataset.inspect" in error["message"]
    assert_invariants(frames)


def test_unknown_model_in_params_is_refused():
    frames, _raw, _code = run_session(
        [encode(host_hello()), encode(embed_request("r-1", ["a"], model="not-a-model"))]
    )
    error = terminal(frames, "r-1")
    assert error["code"] == "MALFORMED_FRAME"
    assert "not-a-model" in error["message"]


def test_missing_extra_names_the_extra_and_the_install_command():
    frames, _raw, _code = run_session(
        [encode(host_hello()), encode(embed_request("r-1", ["a"], model="siglip2-large"))]
    )
    error = terminal(frames, "r-1")
    assert error["code"] == "MISSING_EXTRA"
    assert "vision" in error["message"]
    assert "visionlens[vision]" in error["message"]


def test_missing_extra_clears_when_the_extra_is_installed():
    frames, _raw, _code = run_session(
        [encode(host_hello()), encode(embed_request("r-1", ["a"], model="siglip2-large"))],
        extras=["vision"],
    )
    result = terminal(frames, "r-1")
    assert result["kind"] == "result"
    assert result["result"]["dimension"] == 1152


def test_unsupported_device_is_refused():
    request_frame = request(
        "r-1", "vision.embed", {"images": ["a"], "model": "siglip2-base", "device": "mps"}
    )
    frames, _raw, _code = run_session([encode(host_hello()), encode(request_frame)])
    error = terminal(frames, "r-1")
    assert error["code"] == "UNSUPPORTED_PROTOCOL"
    assert "mps" in error["message"]


def test_device_auto_resolves_to_cpu():
    request_frame = request(
        "r-1", "vision.embed", {"images": ["a"], "model": "siglip2-base", "device": "auto"}
    )
    frames, _raw, _code = run_session([encode(host_hello()), encode(request_frame)])
    result = terminal(frames, "r-1")
    assert result["kind"] == "result"
    assert result["result"]["device"] == "cpu"


def test_budget_tokens_are_enforced_before_any_progress():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(
                request(
                    "r-1",
                    "model.train",
                    {"dataset": "ds", "recipe": "quick"},
                    max_tokens=1,
                )
            ),
        ]
    )
    error = terminal(frames, "r-1")
    assert error["code"] == "BUDGET_EXCEEDED"
    assert frames_for(frames, "r-1")[0] is error  # no progress frames were emitted


def test_duplicate_in_flight_request_id_is_dropped_without_a_frame():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(request("r-1", "model.train", {"dataset": "ds", "recipe": "slow"})),
            encode(request("r-1", "model.train", {"dataset": "ds", "recipe": "quick"})),
            encode({"protocol": protocol.PROTOCOL, "kind": "cancel", "requestId": "r-1"}),
        ]
    )
    # The duplicate never produced a second terminal frame; the original
    # request keeps a clean sequence and ends cancelled.
    assert terminal(frames, "r-1")["code"] == "CANCELLED"
    train_frames = frames_for(frames, "r-1")
    assert len([f for f in train_frames if f["kind"] in ("result", "error")]) == 1
    assert all(f["kind"] != "result" for f in train_frames)
    assert_invariants(frames)


def test_cancel_of_an_in_flight_request_yields_cancelled_and_no_result():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(request("r-1", "model.train", {"dataset": "ds", "recipe": "slow"})),
            encode({"protocol": protocol.PROTOCOL, "kind": "cancel", "requestId": "r-1"}),
        ]
    )
    error = terminal(frames, "r-1")
    assert error["kind"] == "error"
    assert error["code"] == "CANCELLED"
    assert error["retryable"] is False
    assert all(f["kind"] != "result" for f in frames_for(frames, "r-1"))
    assert_invariants(frames)


def test_cancel_of_an_unknown_request_is_a_silent_no_op():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode({"protocol": protocol.PROTOCOL, "kind": "cancel", "requestId": "ghost"}),
            encode(embed_request("r-1", ["a"])),
        ]
    )
    assert frames[0]["kind"] == "hello"
    assert frames[1]["requestId"] == "r-1"
    assert all(f["kind"] != "error" for f in frames)
    assert_invariants(frames)


def test_deadline_stops_a_slow_operation():
    import time

    started = time.monotonic()
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(
                request(
                    "r-1",
                    "model.train",
                    {"dataset": "ds", "recipe": "slow"},
                    max_seconds=1,
                )
            ),
        ]
    )
    elapsed = time.monotonic() - started
    error = terminal(frames, "r-1")
    assert error["code"] == "DEADLINE_EXCEEDED"
    assert "maxSeconds" in error["message"]
    assert all(f["kind"] != "result" for f in frames_for(frames, "r-1"))
    # Monotonic-budget property: the refusal can only be emitted once the
    # full budget has elapsed, and the slow recipe sleeps 100 steps of 0.05s,
    # so an unbudgeted run lasts at least 5.0s. The upper bound sits just
    # under that natural end, generous for a loaded runner, while the step
    # count below is the load-independent proof the loop was cut short.
    assert elapsed >= 1.0
    assert elapsed < 4.8, "the deadline must stop the operation before its natural end"
    progress = [f for f in frames_for(frames, "r-1") if f["kind"] == "progress"]
    assert progress, "the trainer reports its initial progress before any step"
    assert progress[-1]["completed"] < progress[-1]["total"]
    assert_invariants(frames)


def test_seq_is_strictly_increasing_and_starts_at_zero():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(request("r-1", "model.train", {"dataset": "ds", "recipe": "standard"})),
            encode(embed_request("r-2", ["a", "b"])),
        ]
    )
    assert_invariants(frames)
    train = frames_for(frames, "r-1")
    assert train[-1]["kind"] == "result"
    assert train[-1]["seq"] == len(train) - 1


def test_seq_counter_is_pruned_when_the_request_terminates():
    import io
    import json

    from visionlens.worker import Worker

    payload = b"".join(
        (
            encode(host_hello()),
            encode(embed_request("r-1", ["a"])),
            encode(request("r-2", "model.train", {"dataset": "ds", "recipe": "quick"})),
        )
    )
    writer = io.BytesIO()
    worker = Worker(reader=io.BytesIO(payload), writer=writer)
    worker.run()
    frames = [json.loads(line) for line in writer.getvalue().decode("utf-8").splitlines()]
    assert terminal(frames, "r-1")["kind"] == "result"
    assert terminal(frames, "r-2")["kind"] == "result"
    assert_invariants(frames)
    # The terminal frame was each counter's last reader, so a long-lived
    # session does not accumulate one entry per terminated request.
    assert worker._seq_counters == {}  # noqa: SLF001


def test_negotiated_frame_limit_is_enforced():
    padded = request(
        "r-1",
        "vision.embed",
        {"images": ["a"], "model": "siglip2-base"},
        workspace_id="w" * 600,
    )
    small = embed_request("r-2", ["a"])
    frames, _raw, _code = run_session(
        [
            encode(host_hello(max_frame_bytes=512)),
            encode(padded),
            encode(small),
        ]
    )
    oversized = frames[1]
    assert oversized["code"] == "MALFORMED_FRAME"
    assert "512" in oversized["message"]
    assert terminal(frames, "r-2")["kind"] == "result"
    assert_invariants([frames[0]] + [f for f in frames[1:] if "requestId" in f])


def test_default_frame_limit_is_one_mib():
    at_limit = b"a" * 1048576
    over_limit = b"a" * 1048577
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            over_limit,
            at_limit,
            encode(embed_request("r-1", ["a"])),
        ]
    )
    assert "exceeds" in frames[1]["message"]
    assert frames[1]["code"] == "MALFORMED_FRAME"
    # exactly at the limit is not oversized, it is just not valid JSON
    assert "not valid JSON" in frames[2]["message"]
    assert terminal(frames, "r-1")["kind"] == "result"
    assert_invariants([frames[0]] + [f for f in frames[1:] if "requestId" in f])


def test_all_five_operations_produce_results():
    operations = [
        ("vision.embed", {"images": ["a", "b"], "model": "siglip2-base"}),
        ("vision.predict", {"images": ["a"], "model": "clip-vit-b32"}),
        ("dataset.audit", {"root": "/datasets/visa"}),
        ("eval.run", {"split": "test", "predictions": "runs/1"}),
        ("model.train", {"dataset": "ds", "recipe": "quick"}),
    ]
    lines = [encode(host_hello())]
    for index, (operation, params) in enumerate(operations):
        lines.append(encode(request("r-" + str(index), operation, params)))
    frames, _raw, _code = run_session(lines)
    assert_invariants(frames)
    for index in range(len(operations)):
        result = terminal(frames, "r-" + str(index))
        assert result["kind"] == "result", operation_for(operations, index)


def operation_for(operations: list, index: int) -> str:
    return operations[index][0]


def test_embed_result_carries_the_frozen_fields():
    frames, _raw, _code = run_session(
        [encode(host_hello()), encode(embed_request("r-1", ["golden-alpha", "golden-beta"]))]
    )
    result = terminal(frames, "r-1")["result"]
    assert set(result) == {
        "model",
        "dimension",
        "dtype",
        "count",
        "vectors",
        "artifactSha256",
        "preprocessingFingerprint",
        "device",
    }
    assert result["model"] == "siglip2-base"
    assert result["count"] == 2
    assert len(result["vectors"]) == 2
    assert all(len(v) == 768 for v in result["vectors"])
    assert result["dtype"] == "float32"
    assert result["preprocessingFingerprint"].startswith("fp2:")
    assert len(result["artifactSha256"]) == 64


def test_predict_result_carries_the_frozen_fields():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(
                request(
                    "r-1", "vision.predict", {"images": ["img-1"], "model": "clip-vit-b32"}
                )
            ),
        ]
    )
    result = terminal(frames, "r-1")["result"]
    assert set(result) == {"model", "predictions", "artifactSha256"}
    prediction = result["predictions"][0]
    assert set(prediction) == {"image", "labelKey", "probability"}
    assert prediction["image"] == "img-1"
    assert prediction["labelKey"].startswith("label.")
    assert 0.0 < prediction["probability"] <= 1.0


def test_audit_and_eval_result_fields():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(request("r-1", "dataset.audit", {"root": "/datasets/visa"})),
            encode(request("r-2", "eval.run", {"split": "test", "predictions": "runs/1"})),
        ]
    )
    audit = terminal(frames, "r-1")["result"]
    assert set(audit) == {"samples", "duplicates", "missingHashes", "classCounts", "licenseGaps"}
    assert audit["duplicates"] <= audit["samples"]
    assert sum(audit["classCounts"].values()) == audit["samples"]
    evaluation = terminal(frames, "r-2")["result"]
    assert set(evaluation) == {"macroF1", "perClass", "balancedAccuracy", "ece", "support"}
    assert 0.0 <= evaluation["macroF1"] <= 1.0


def test_train_result_carries_the_frozen_fields():
    frames, _raw, _code = run_session(
        [
            encode(host_hello()),
            encode(request("r-1", "model.train", {"dataset": "ds", "recipe": "quick"})),
        ]
    )
    result = terminal(frames, "r-1")["result"]
    assert set(result) == {"modelId", "artifactSha256", "metrics"}
    assert result["modelId"].startswith("sim-")
    assert result["metrics"]["steps"] == 4
