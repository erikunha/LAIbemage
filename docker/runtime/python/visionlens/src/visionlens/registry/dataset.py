"""The dataset entries of the registry file, and the refusals they earn.

The dataset schema belongs to the dataset reader
(`packages/core/src/benchmark/registry.ts`), and this module is its mirror:
the same fields, the same rules and the same refusals, so a registry file
that one reader calls usable the other reader calls usable too. The
repository holds the two languages to one shape (the worker protocol is
mirrored the same way), and a mirrored schema without a check is a drift
waiting to happen.

Every refusal names the offending field by its path in the file
(`datasets.0.license`), which is the path the TypeScript reader names.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Sequence, Tuple

#: What a dataset may be used for.
DATASET_USAGES: Tuple[str, ...] = ("benchmark", "research-only")

#: Every field a dataset entry carries, and nothing else.
DATASET_FIELDS: Tuple[str, ...] = (
    "id",
    "title",
    "usage",
    "license",
    "licenseUrl",
    "commercialUse",
    "source",
    "resource",
    "version",
    "archiveBytes",
    "etag",
    "parts",
    "sha256",
    "sha256PinnedAt",
    "attribution",
    "fetchedAt",
    "notes",
)

#: The fields of the nested parts object, and nothing else.
PARTS_FIELDS: Tuple[str, ...] = ("selected", "rationale")

#: The sha256 of the fetched bytes, in the shape a digest always has.
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class DatasetEntryError(Exception):
    """Raised when a dataset entry cannot be trusted.

    The message names the offending field by its path in the file.
    """

    def __init__(self, field: str, reason: str) -> None:
        message = "the dataset registry has an unusable " + field + ": " + reason
        super().__init__(message)
        self.field = field
        self.reason = reason


def _refuse(field: str, reason: str) -> DatasetEntryError:
    return DatasetEntryError(field, reason)


#: The schemes whose URL must name a host, as the URL constructor requires.
_HOST_REQUIRED_SCHEMES = ("http", "https", "ws", "wss", "ftp")


def is_url(value: str) -> bool:
    """Whether a string parses as a URL.

    The rule of the TypeScript reader (`z.url()`): the URL constructor
    accepts it. A location without a scheme is not a location, and a scheme
    that must name a host does not accept an empty one.
    """
    from urllib.parse import urlparse

    parsed = urlparse(value)
    if not parsed.scheme:
        return False
    if parsed.scheme in _HOST_REQUIRED_SCHEMES and not parsed.netloc:
        return False
    return True


def is_iso_datetime(value: str) -> bool:
    """Whether a string is an ISO datetime with an offset.

    The rule of the TypeScript reader (`z.iso.datetime({ offset: true })`):
    the instant is unambiguous, because it names its offset.
    """
    from datetime import datetime

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _require_string(
    value: Any, field: str, *, allow_empty: bool = False
) -> str:
    if not isinstance(value, str):
        raise _refuse(field, "expected a string, got " + type(value).__name__)
    if not allow_empty and not value:
        raise _refuse(field, "expected a non-empty string")
    return value


def _require_url(value: Any, field: str) -> str:
    text = _require_string(value, field)
    if not is_url(text):
        raise _refuse(field, "expected a URL")
    return text


def _require_nullable_string(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _require_string(value, field)


def _require_nullable_datetime(value: Any, field: str) -> str | None:
    if value is None:
        return None
    text = _require_string(value, field)
    if not is_iso_datetime(text):
        raise _refuse(field, "expected an ISO datetime with an offset")
    return text


def validate_dataset_entry(entry: Any, path: str) -> Dict[str, Any]:
    """Validate one dataset entry and return its checked fields.

    The rules are the rules of the TypeScript dataset schema, field for
    field: the same required fields, the same vocabularies, the same
    sha256 pairing rule and the same refusal of an unknown field.
    """
    if not isinstance(entry, Mapping):
        raise _refuse(path, "expected an object")
    for key in entry:
        if key not in DATASET_FIELDS:
            raise _refuse(
                path + "." + key, "the entry carries a field the registry does not define"
            )

    if "id" not in entry:
        raise _refuse(path + ".id", "the entry does not carry this field")
    dataset_id = _require_string(entry["id"], path + ".id")

    if "title" not in entry:
        raise _refuse(path + ".title", "the entry does not carry this field")
    _require_string(entry["title"], path + ".title")

    if "usage" not in entry:
        raise _refuse(path + ".usage", "the entry does not carry this field")
    usage = entry["usage"]
    if usage not in DATASET_USAGES:
        raise _refuse(
            path + ".usage",
            "expected one of " + "|".join(DATASET_USAGES) + ", got " + repr(usage),
        )

    if "license" not in entry:
        raise _refuse(path + ".license", "the entry does not carry this field")
    license_text = _require_string(entry["license"], path + ".license")

    if "licenseUrl" not in entry:
        raise _refuse(path + ".licenseUrl", "the entry does not carry this field")
    _require_url(entry["licenseUrl"], path + ".licenseUrl")

    if "commercialUse" not in entry:
        raise _refuse(path + ".commercialUse", "the entry does not carry this field")
    if not isinstance(entry["commercialUse"], bool):
        raise _refuse(
            path + ".commercialUse",
            "expected a boolean, got " + type(entry["commercialUse"]).__name__,
        )

    for field in ("source", "resource"):
        if field not in entry:
            raise _refuse(path + "." + field, "the entry does not carry this field")
        _require_url(entry[field], path + "." + field)

    if "version" not in entry:
        raise _refuse(path + ".version", "the entry does not carry this field")
    _require_string(entry["version"], path + ".version")

    if "archiveBytes" not in entry:
        raise _refuse(path + ".archiveBytes", "the entry does not carry this field")
    archive_bytes = entry["archiveBytes"]
    if archive_bytes is not None:
        if isinstance(archive_bytes, bool) or not isinstance(archive_bytes, int):
            raise _refuse(
                path + ".archiveBytes",
                "expected an integer, got " + type(archive_bytes).__name__,
            )
        if archive_bytes < 0:
            raise _refuse(path + ".archiveBytes", "expected a number of 0 or more")

    if "etag" not in entry:
        raise _refuse(path + ".etag", "the entry does not carry this field")
    _require_nullable_string(entry["etag"], path + ".etag")

    if "parts" not in entry:
        raise _refuse(path + ".parts", "the entry does not carry this field")
    parts = entry["parts"]
    if not isinstance(parts, Mapping):
        raise _refuse(path + ".parts", "expected an object")
    for key in parts:
        if key not in PARTS_FIELDS:
            raise _refuse(
                path + ".parts." + key, "the object carries a field the registry does not define"
            )
    if "selected" not in parts:
        raise _refuse(path + ".parts.selected", "the object does not carry this field")
    selected = parts["selected"]
    if not isinstance(selected, (list, tuple)):
        raise _refuse(path + ".parts.selected", "expected a list of strings")
    for index, item in enumerate(selected):
        _require_string(item, path + ".parts.selected." + str(index))
    if "rationale" not in parts:
        raise _refuse(path + ".parts.rationale", "the object does not carry this field")
    _require_string(parts["rationale"], path + ".parts.rationale")

    if "sha256" not in entry:
        raise _refuse(path + ".sha256", "the entry does not carry this field")
    digest = entry["sha256"]
    if digest is not None:
        if not isinstance(digest, str) or not _SHA256_PATTERN.match(digest):
            raise _refuse(
                path + ".sha256", "expected a 64-character lowercase sha256 digest"
            )

    if "sha256PinnedAt" not in entry:
        raise _refuse(path + ".sha256PinnedAt", "the entry does not carry this field")
    pinned_at = _require_nullable_datetime(entry["sha256PinnedAt"], path + ".sha256PinnedAt")

    if "attribution" not in entry:
        raise _refuse(path + ".attribution", "the entry does not carry this field")
    _require_string(entry["attribution"], path + ".attribution")

    if "fetchedAt" not in entry:
        raise _refuse(path + ".fetchedAt", "the entry does not carry this field")
    _require_nullable_datetime(entry["fetchedAt"], path + ".fetchedAt")

    if "notes" not in entry:
        raise _refuse(path + ".notes", "the entry does not carry this field")
    _require_string(entry["notes"], path + ".notes", allow_empty=True)

    if digest is not None and pinned_at is None:
        raise _refuse(
            path + ".sha256PinnedAt", "a pinned sha256 must carry the timestamp it was pinned at"
        )
    if pinned_at is not None and digest is None:
        raise _refuse(
            path + ".sha256",
            "a pinned timestamp without a sha256 means the checksum was lost, not recorded",
        )

    return {
        "id": dataset_id,
        "license": license_text,
        "usage": usage,
    }


def dataset_ids(entries: Sequence[Mapping[str, Any]]) -> Tuple[str, ...]:
    """Return the ids of the checked entries, in order."""
    ids: List[str] = [str(entry["id"]) for entry in entries]
    return tuple(ids)
