"""The runtime: the device the run uses, and the machine it runs on.

The CPU is the reference path of this platform
(docs/vnext/adrs/ADR-017-local-first-hardware.md:9). An accelerator is
optional, and it is used only when the machine proves it is there.

The runtime of this package is the side of the adapter that knows about
the machine: which device a run may use, and how it is reached.
"""

from __future__ import annotations

from .device import (
    ADMITTED_DEVICES,
    CPU_DEVICE,
    KNOWN_DEVICES,
    REQUESTABLE_DEVICES,
    DevicePlan,
    DevicePlanner,
    probe_available_devices,
)

__all__ = [
    "ADMITTED_DEVICES",
    "CPU_DEVICE",
    "KNOWN_DEVICES",
    "REQUESTABLE_DEVICES",
    "DevicePlan",
    "DevicePlanner",
    "probe_available_devices",
]
