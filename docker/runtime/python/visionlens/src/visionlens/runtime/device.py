"""The device planner: which device a run uses, and why.

The CPU is the reference path of this platform
(docs/vnext/adrs/ADR-017-local-first-hardware.md:9). An accelerator is
optional, and it is used only when the machine proves it is there: the
planner asks the environment, not the request.

Two rules, and they are not the same rule:

  - `auto` FALLS BACK. It resolves to the CPU reference path and records
    the reason it fell back, because a run that quietly ran somewhere
    else is a run nobody can reproduce.
  - an EXPLICIT device is REFUSED when the machine does not have it. A
    request for an accelerator that is not there fails with its reason
    instead of running elsewhere.

The environment is asked once, and the answer is injectable, so the
fallback is a property of the planner and not of the machine the tests
happen to run on.
"""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from typing import Mapping, Optional

from ..errors import UnsupportedDeviceError

#: The device the platform references. Every run may use it.
CPU_DEVICE = "cpu"

#: The devices this platform knows by name. `auto` is a request, not a
#: device: it resolves to one of the others.
DEVICE_NAMES: tuple[str, ...] = ("auto", "cpu", "mps", "cuda")

#: The accelerator `auto` prefers. CUDA is a separate runner in this
#: platform, never the local fallback.
PREFERRED_ACCELERATOR = "mps"


@dataclass(frozen=True)
class DevicePlan:
    """The device a run uses, and the reason it uses it.

    `fallback_reason` is set when a request for `auto` did not get the
    device it asked for. It is `None` when there was no fallback: an
    explicit request that was satisfied, or an `auto` that found the
    accelerator.
    """

    device: str
    reason: str
    fallback_reason: Optional[str] = None


def probe_available_devices() -> dict[str, bool]:
    """Ask the machine which of the optional devices it has.

    The probe never imports torch when torch is not installed, and it
    never raises: a machine that cannot answer has no accelerator.
    """
    available: dict[str, bool] = {CPU_DEVICE: True}
    try:
        if importlib.util.find_spec("torch") is None:
            return available
    except (ImportError, ValueError):
        return available
    try:
        torch = importlib.import_module("torch")
    except Exception:  # pragma: no cover - a broken install is not a device
        return available
    available["mps"] = _backend_available(torch, "backends", "mps")
    available["cuda"] = _backend_available(torch, "cuda")
    return available


def _backend_available(torch: object, *path: str) -> bool:
    """Whether a torch backend reports itself as available.

    The backend is reached by name, so a torch build without it, or a
    torch that cannot answer, is an absent device and not a crash.
    """
    current: object = torch
    for name in path:
        current = getattr(current, name, None)
        if current is None:
            return False
    is_available = getattr(current, "is_available", None)
    if not callable(is_available):
        return False
    try:
        return bool(is_available())
    except Exception:  # pragma: no cover - a backend that cannot answer
        return False


class DevicePlanner:
    """Resolve a requested device into the device a run may use.

    The planner holds the answer of the environment, so a run records the
    device it really used and the reason it used it.
    """

    def __init__(self, available: Optional[Mapping[str, bool]] = None) -> None:
        if available is None:
            available = probe_available_devices()
        self._available = dict(available)

    @property
    def available(self) -> tuple[str, ...]:
        """The names of the devices this machine has, in a stable order."""
        return tuple(name for name in DEVICE_NAMES if self._available.get(name, False))

    def plan(self, requested: str) -> DevicePlan:
        """Resolve a requested device, or refuse it with its reason.

        @raises UnsupportedDeviceError when the device may not be used.
        """
        if requested not in DEVICE_NAMES:
            raise UnsupportedDeviceError(
                "the device "
                + repr(requested)
                + " is not a device this platform knows ("
                + ", ".join(DEVICE_NAMES)
                + ")"
            )
        if requested == CPU_DEVICE:
            return DevicePlan(
                device=CPU_DEVICE,
                reason="the requested device is the CPU reference path",
            )
        if requested == "auto":
            return self._plan_auto()
        if not self._available.get(requested, False):
            raise UnsupportedDeviceError(
                "the device "
                + repr(requested)
                + " is not available on this machine; the available devices are "
                + (", ".join(self.available) or "none")
            )
        return DevicePlan(
            device=requested,
            reason=(
                "the requested device is "
                + requested
                + ", which this machine provides"
            ),
        )

    def _plan_auto(self) -> DevicePlan:
        """Resolve `auto`: the accelerator when the machine has one."""
        if self._available.get(PREFERRED_ACCELERATOR, False):
            return DevicePlan(
                device=PREFERRED_ACCELERATOR,
                reason=(
                    "auto resolved to "
                    + PREFERRED_ACCELERATOR
                    + ", which this machine provides"
                ),
            )
        return DevicePlan(
            device=CPU_DEVICE,
            reason="auto resolved to the CPU reference path",
            fallback_reason=(
                PREFERRED_ACCELERATOR + " is not available on this machine"
            ),
        )
