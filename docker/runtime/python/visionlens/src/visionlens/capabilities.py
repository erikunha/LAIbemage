"""The capability report of a local client (spec 017, US3).

The record answers one question: what can this build actually do on this
machine, and what does it refuse? It names the resolved device, the state of
every declared extra and the package version, and it is serializable, so a
caller can record it next to a result.

Nothing here is claimed beyond what the environment proves: an extra is
available only when the modules its capability needs are importable, and the
reason field says why it is not. The device is resolved by the device
planner, the only resolver of the platform, so the report and the run
cannot disagree about where a run happens.
"""

from __future__ import annotations

import importlib.util
from typing import Mapping

from pydantic import BaseModel, ConfigDict

from .config import LocalConfig
from .runtime.device import DevicePlanner

CAPABILITIES_SCHEMA_VERSION = 1

# The modules each declared extra needs, by capability. The requirement
# RANGES live in pyproject.toml; this map names what the environment is asked
# about. The `all` extra is the union of the four capabilities.
EXTRA_CAPABILITY_MODULES: Mapping[str, tuple[str, ...]] = {
    "vision": ("torch", "transformers"),
    "training": ("torch", "sklearn"),
    "agents": ("langgraph",),
    "server": ("fastapi", "uvicorn"),
}

#: Every declared extra, in the order the distribution declares them.
EXTRA_NAMES: tuple[str, ...] = ("vision", "training", "agents", "server", "all")


class ExtraCapability(BaseModel):
    """The state of one declared extra in this environment."""

    model_config = ConfigDict(frozen=True)

    #: The extra name, exactly as the distribution declares it.
    name: str
    #: True when the modules the capability needs are importable.
    available: bool
    #: Why the extra is or is not available, in one sentence.
    reason: str
    #: The modules that are absent, empty when the extra is available.
    missing_modules: tuple[str, ...] = ()


class Capabilities(BaseModel):
    """The serializable capability record of a local client."""

    model_config = ConfigDict(frozen=True)

    #: The schema version of this record.
    schema_version: int = CAPABILITIES_SCHEMA_VERSION
    #: The resolved device.
    device: str
    #: Why that device was chosen.
    device_reason: str
    #: The state of every declared extra.
    extras: tuple[ExtraCapability, ...]
    #: The package version.
    version: str

    @property
    def installed_extras(self) -> tuple[str, ...]:
        """The names of the extras whose capability stack is present."""
        return tuple(extra.name for extra in self.extras if extra.available)


def resolve_device(device: str) -> tuple[str, str]:
    """Resolve a requested device into the device and the reason for it.

    The device planner is the only resolver of the platform: the report
    and the run ask the same question, so they cannot answer it in two
    different ways. The planner asks the environment, so a machine with
    the `vision` extra installed answers with the accelerator it has and
    the reason the build did not admit it.
    """
    plan = DevicePlanner().plan(device)
    reason = plan.reason
    if plan.fallback_reason:
        reason = reason + ": " + plan.fallback_reason
    return plan.device, reason


def _modules_for(extra: str) -> tuple[str, ...]:
    if extra == "all":
        modules: list[str] = []
        for name in ("vision", "training", "agents", "server"):
            for module in EXTRA_CAPABILITY_MODULES[name]:
                if module not in modules:
                    modules.append(module)
        return tuple(modules)
    return EXTRA_CAPABILITY_MODULES.get(extra, ())


def _is_importable(module: str) -> bool:
    """Whether the module is importable, without importing it."""
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _extra_capability(extra: str) -> ExtraCapability:
    missing = tuple(module for module in _modules_for(extra) if not _is_importable(module))
    if not missing:
        return ExtraCapability(
            name=extra,
            available=True,
            reason="the capability stack is installed",
        )
    return ExtraCapability(
        name=extra,
        available=False,
        reason="missing modules: " + ", ".join(missing),
        missing_modules=missing,
    )


def resolve_capabilities(config: LocalConfig) -> Capabilities:
    """Build the capability record for a configuration."""
    from . import __version__

    device, reason = resolve_device(config.device)
    return Capabilities(
        device=device,
        device_reason=reason,
        extras=tuple(_extra_capability(extra) for extra in EXTRA_NAMES),
        version=__version__,
    )
