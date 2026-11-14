"""The device planner: the chosen device and the reason it was chosen.

The CPU is the reference path, `auto` falls back to it and says why, and
a device this build does not admit is refused instead of being replaced
by another one.
"""

from __future__ import annotations

from pathlib import Path
from typing import get_args

import pytest

from helpers import SRC  # noqa: F401  (path setup)

from visionlens.config import SUPPORTED_DEVICES, DeviceRequest
from visionlens.errors import UnsupportedDeviceError
from visionlens.runtime.device import (
    ADMITTED_DEVICES,
    CPU_DEVICE,
    KNOWN_DEVICES,
    REQUESTABLE_DEVICES,
    DevicePlan,
    DevicePlanner,
    probe_available_devices,
)


def test_auto_on_a_machine_without_mps_records_the_cpu_and_the_fallback_reason():
    # Task 2.4: `auto` on a machine without MPS records the chosen device
    # `cpu` AND the reason it fell back.
    planner = DevicePlanner({"cpu": True, "mps": False, "cuda": False})

    plan = planner.plan("auto")

    assert isinstance(plan, DevicePlan)
    assert plan.device == CPU_DEVICE
    assert plan.reason
    assert plan.fallback_reason is not None
    assert "mps" in plan.fallback_reason


def test_auto_names_the_accelerator_the_machine_has_and_does_not_admit():
    # The reason of a fallback names the accelerator that was there and
    # was not preferred, so a reader of the run knows the run was not a
    # choice the machine made for it.
    planner = DevicePlanner({"cpu": True, "mps": True, "cuda": True})

    plan = planner.plan("auto")

    assert plan.device == CPU_DEVICE
    assert plan.fallback_reason is not None
    assert "mps" in plan.fallback_reason
    assert "cuda" in plan.fallback_reason


def test_auto_falls_back_to_the_cpu_even_when_the_machine_has_an_accelerator():
    # This build admits the CPU only, so an accelerator that the machine
    # provides is never used by a run.
    planner = DevicePlanner({"cpu": True, "mps": True, "cuda": False})

    plan = planner.plan("auto")

    assert plan.device == CPU_DEVICE
    assert plan.fallback_reason is not None


def test_an_explicit_device_the_machine_does_not_have_is_refused():
    # A request for an accelerator that is not there fails with its reason
    # instead of running somewhere else.
    planner = DevicePlanner({"cpu": True, "mps": False, "cuda": False})

    with pytest.raises(UnsupportedDeviceError) as excinfo:
        planner.plan("mps")

    assert excinfo.value.code.value == "UNSUPPORTED_DEVICE"
    assert "mps" in str(excinfo.value)
    assert "cpu" in str(excinfo.value)


def test_an_explicit_accelerator_is_refused_even_when_the_machine_has_it():
    # The vocabulary of the request and the vocabulary of the admitted
    # devices are one vocabulary: this build admits the CPU only.
    planner = DevicePlanner({"cpu": True, "mps": True, "cuda": True})

    with pytest.raises(UnsupportedDeviceError) as excinfo:
        planner.plan("cuda")

    assert excinfo.value.code.value == "UNSUPPORTED_DEVICE"
    assert "cuda" in str(excinfo.value)


def test_the_cpu_is_always_available_and_always_satisfied():
    planner = DevicePlanner({"cpu": True, "mps": False, "cuda": False})

    plan = planner.plan("cpu")

    assert plan.device == CPU_DEVICE
    assert plan.fallback_reason is None


def test_a_device_the_platform_does_not_know_is_refused():
    planner = DevicePlanner({"cpu": True})

    with pytest.raises(UnsupportedDeviceError) as excinfo:
        planner.plan("tpu")

    assert "tpu" in str(excinfo.value)
    for name in KNOWN_DEVICES:
        assert name in str(excinfo.value)


def test_the_planner_reports_the_devices_the_machine_has():
    planner = DevicePlanner({"cpu": True, "mps": False, "cuda": True})

    assert planner.available == ("cpu", "cuda")


def test_the_planner_reports_the_admitted_devices_it_may_run_on():
    planner = DevicePlanner({"cpu": True, "mps": True, "cuda": True})

    assert planner.admitted == ("cpu",)


def test_the_probe_answers_without_raising_on_any_machine():
    # The probe asks the environment and never raises: a machine that
    # cannot answer has the CPU and nothing else.
    available = probe_available_devices()

    assert available.get("cpu") is True
    assert set(available) <= set(KNOWN_DEVICES)


def test_the_probe_does_not_import_torch_when_it_is_absent(monkeypatch):
    import importlib.util

    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)

    available = probe_available_devices()

    assert available == {"cpu": True}


def test_the_probe_reports_a_broken_torch_as_a_machine_without_accelerator(
    monkeypatch,
):
    import importlib

    def broken(name):
        raise RuntimeError("the install is broken")

    monkeypatch.setattr(importlib, "import_module", broken)

    available = probe_available_devices()

    assert available == {"cpu": True}


def test_the_plan_is_a_frozen_record_of_the_run():
    plan = DevicePlanner({"cpu": True}).plan("auto")

    with pytest.raises(Exception):
        plan.device = "mps"  # type: ignore[misc]


def test_the_planner_names_the_reference_device_of_the_platform():
    assert CPU_DEVICE == "cpu"
    assert "auto" in REQUESTABLE_DEVICES


def test_the_request_vocabulary_is_the_one_the_configuration_uses():
    # One vocabulary: the configuration, the planner and the capability
    # report read the same names, and the literal the configuration
    # validates against names the same devices.
    assert SUPPORTED_DEVICES == REQUESTABLE_DEVICES
    assert get_args(DeviceRequest) == SUPPORTED_DEVICES
    assert REQUESTABLE_DEVICES == ("auto",) + ADMITTED_DEVICES
    assert ADMITTED_DEVICES == (CPU_DEVICE,)
    assert set(ADMITTED_DEVICES) <= set(KNOWN_DEVICES)
