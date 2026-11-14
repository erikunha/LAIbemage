"""The versioned local configuration of the public facade (spec 017, US3).

The model is a Pydantic model on purpose: the pack puts Pydantic in the base
install (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34`) and the facade's contract
is a typed configuration that round-trips through plain JSON.

The configuration carries its own schema version. A payload written by another
version is refused rather than interpreted: a config that silently changes
meaning is worse than one that is rejected.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

from .errors import (
    ConfigInvalidError,
    ConfigVersionUnsupportedError,
    UnsupportedDeviceError,
)
from .runtime.device import REQUESTABLE_DEVICES

CONFIG_SCHEMA_VERSION = 1

# The devices this build provides. `auto` resolves to the CPU reference path;
# the accelerator decision stays open in ADR-007 against the pack's ADR-017,
# so no accelerator device is claimed here. The list is the vocabulary of
# the device planner, not a second one: `REQUESTABLE_DEVICES` is what a
# request may name, and this build admits the CPU only.
DeviceRequest = Literal["auto", "cpu"]

SUPPORTED_DEVICES: tuple[str, ...] = REQUESTABLE_DEVICES


class LocalConfig(BaseModel):
    """The configuration of a local client."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    #: The schema version of this configuration. A payload carrying another
    #: version is refused by `from_json`.
    schema_version: int = CONFIG_SCHEMA_VERSION
    #: The requested device: `auto` or `cpu`.
    device: DeviceRequest = "auto"
    #: Where the client may keep its cache. None means no cache directory.
    cache_dir: Path | None = None

    @field_validator("device", mode="before")
    @classmethod
    def _device_is_supported(cls, value: str) -> str:
        # A "before" validator runs ahead of the literal check, so an unknown
        # device is refused with the typed error instead of pydantic's own
        # validation message.
        if value not in SUPPORTED_DEVICES:
            raise UnsupportedDeviceError(
                "the device "
                + repr(value)
                + " is not provided by this build; the supported devices are "
                + ", ".join(repr(name) for name in SUPPORTED_DEVICES)
            )
        return value

    def to_json(self) -> str:
        """Serialize the configuration to plain JSON."""
        return self.model_dump_json()

    @classmethod
    def from_json(cls, raw: str) -> "LocalConfig":
        """Parse a configuration from plain JSON.

        Refuses a payload that is not a JSON object, that carries another
        schema version, or that this build cannot parse. Every refusal is a
        typed error carrying a stable code.
        """
        try:
            payload: Any = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ConfigInvalidError(
                "the configuration is not valid JSON: " + exc.msg
            ) from exc
        if not isinstance(payload, dict):
            raise ConfigInvalidError("the configuration must be a JSON object")

        version = payload.get("schema_version", CONFIG_SCHEMA_VERSION)
        # The version is an integer and nothing else: `true` and `1.0` compare
        # equal to `1` in Python, and a version field that accepts them is not
        # versioned at all.
        if (
            not isinstance(version, int)
            or isinstance(version, bool)
            or version != CONFIG_SCHEMA_VERSION
        ):
            raise ConfigVersionUnsupportedError(
                "the configuration schema version "
                + repr(version)
                + " is not supported by this build; this build speaks version "
                + str(CONFIG_SCHEMA_VERSION)
            )

        try:
            return cls.model_validate(payload)
        except ValidationError as exc:
            raise ConfigInvalidError(
                "the configuration is not valid: " + _first_error(exc)
            ) from exc


def _first_error(exc: ValidationError) -> str:
    """The first validation message, without the traceback pydantic renders."""
    errors = exc.errors()
    if not errors:
        return "the configuration does not satisfy the model"
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ()))
    message = str(first.get("msg", "invalid value"))
    return (location + ": " + message) if location else message
