"""The device planner: which device a run uses, and why.

One vocabulary, one resolver. The names live here, the configuration
reads them, and the capability report asks this planner, so the three
cannot drift apart and the platform cannot answer a question about the
device in two different ways.

The CPU is the reference path of this platform
(docs/vnext/adrs/ADR-017-local-first-hardware.md:9). An accelerator is
optional, and it is used only when the machine proves it is there: the
planner asks the environment, not the request.

Three vocabularies, and they are not the same vocabulary:

  - `KNOWN_DEVICES` is every device the platform knows by name. The
    names come from the device support the registry record carries
    (docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:35).
  - `ADMITTED_DEVICES` is the devices a run may actually use, in the
    order `auto` prefers them. An accelerator joins this set only when
    the memory admission and the operator compatibility check the pack
    asks for are implemented (docs/vnext/05-PYTHON-CORE-AND-PYPI.md:61).
  - `REQUESTABLE_DEVICES` is what a request may name. `auto` is a
    request, not a device: it resolves to one of the admitted devices.

Two rules, and they are not the same rule:

  - `auto` FALLS BACK. It resolves to an admitted device and records the
    reason it fell back, because a run that quietly ran somewhere else
    is a run nobody can reproduce.
  - an EXPLICIT device is REFUSED when this build does not admit it. A
    request for an accelerator this build does not run fails with its
    reason instead of running somewhere else.

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

#: Every device the platform knows by name, admitted or not.
KNOWN_DEVICES: tuple[str, ...] = ("cpu", "mps", "cuda")

#: The devices a run may use, in the order `auto` prefers them. The CPU
#: is the reference path, and it is the only device this build admits:
#: admitting an accelerator without the memory admission and the
#: operator compatibility check would claim a capability the platform
#: does not have.
ADMITTED_DEVICES: tuple[str, ...] = (CPU_DEVICE,)

#: What a request may name. `auto` is a request, not a device.
REQUESTABLE_DEVICES: tuple[str, ...] = ("auto",) + ADMITTED_DEVICES


@dataclass(frozen=True)
class DevicePlan:
    """The device a run uses, and the reason it uses it.

    `fallback_reason` is set when a request for `auto` did not get the
    device it asked for. It is `None` when there was no fallback: an
    explicit request that was satisfied.
    """

    device: str
    reason: str
    fallback_reason: Optional[str] = None


def probe_available_devices() -> dict[str, bool]:
    """Ask the machine which of the optional devices it has.

    The probe never imports torch when torch is not installed, and it
    never raises: a machine that cannot answer has the CPU and nothing
    else.
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
        return tuple(name for name in KNOWN_DEVICES if self._available.get(name, False))

    @property
    def admitted(self) -> tuple[str, ...]:
        """The admitted devices this machine has, in the order of preference."""
        return tuple(name for name in ADMITTED_DEVICES if self._available.get(name, False))

    def plan(self, requested: str) -> DevicePlan:
        """Resolve a requested device, or refuse it with its reason.

        @raises UnsupportedDeviceError when the device may not be used.
        """
        if requested not in REQUESTABLE_DEVICES:
            raise UnsupportedDeviceError(
                "the device "
                + repr(requested)
                + " is not a device this build may run on ("
                + ", ".join(REQUESTABLE_DEVICES)
                + "); the devices this platform knows are "
                + ", ".join(KNOWN_DEVICES)
            )
        if requested == CPU_DEVICE:
            return DevicePlan(
                device=CPU_DEVICE,
                reason="the requested device is the CPU reference path",
            )
        return self._plan_auto()

    def _plan_auto(self) -> DevicePlan:
        """Resolve `auto`: the best admitted device the machine has.

        The reason of a fallback names the accelerators the platform knows
        and what the machine has of them, so a reader of the run knows
        whether the run was a choice the machine made for it.
        """
        for name in ADMITTED_DEVICES:
            if name != CPU_DEVICE and self._available.get(name, False):
                return DevicePlan(
                    device=name,
                    reason="auto resolved to " + name + ", which this machine provides",
                )
        accelerators = tuple(name for name in KNOWN_DEVICES if name != CPU_DEVICE)
        present = tuple(
            name for name in accelerators if self._available.get(name, False)
        )
        if present:
            detail = (
                "the machine provides "
                + ", ".join(present)
                + ", which this build does not admit"
            )
        else:
            detail = (
                "the machine provides none of the accelerators this platform knows ("
                + ", ".join(accelerators)
                + ")"
            )
        return DevicePlan(
            device=CPU_DEVICE,
            reason="auto resolved to the CPU reference path",
            fallback_reason="this build admits only the CPU reference path; " + detail,
        )
