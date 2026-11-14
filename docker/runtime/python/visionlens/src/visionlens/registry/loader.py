"""Reading the model capability registry and resolving an encoder.

The registry file is `datasets/registry.json`: the datasets the platform may
use and, since format version 2, the models it may run. This module reads
the models array and resolves a model id to its record.

The rules are the rules of the TypeScript reader
(`packages/core/src/benchmark/registry.ts`), and a refusal names the same
path in both languages (`models.0.sourceDigest`,
`models.0.inputImageSize.width`). A reader that accepts a file the other
one refuses makes the registry's promises decoration.

The loader reads a FILE and nothing else. Resolving a model never reaches
the network: the record says which bytes the model is, and fetching those
bytes is a separate, explicitly permitted act (the weights loader, spec 019
task 1.5). A resolution that quietly downloaded the weights would make the
registry's digest a decoration instead of a promise.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple

from .dataset import DatasetEntryError, validate_dataset_entry
from .record import (
    DEVICE_SUPPORT,
    INPUT_IMAGE_SIZE_FIELDS,
    NON_EMPTY_STRING_FIELDS,
    OUTPUT_SHAPE_FIELDS,
    RECORD_FIELDS,
    STRING_FIELDS,
    URL_FIELDS,
    ModelRecord,
    ModelRecordError,
    is_absolute_url,
)

#: The registry file format versions this module reads. Version 2 added the
#: optional models array; the datasets array did not change.
READABLE_SCHEMA_VERSIONS: Tuple[int, ...] = (1, 2)

#: The fields the registry file carries, and nothing else.
REGISTRY_FIELDS: Tuple[str, ...] = ("schemaVersion", "datasets", "models")


class ModelRegistryError(Exception):
    """Raised when the registry file itself cannot be read or understood.

    The message names the offending field, so a caller learns what to fix.
    """

    def __init__(self, path: str, reason: str, field: str | None = None) -> None:
        message = "the model registry at '" + path + "' cannot be used: " + reason
        if field is not None:
            message = (
                "the model registry at '" + path + "' cannot be used: " + field + ": " + reason
            )
        super().__init__(message)
        self.path = path
        self.field = field
        self.reason = reason


class ModelNotFoundError(Exception):
    """Raised when a model id is not in the registry.

    The message names the model AND the registry it was looked for in, so a
    caller that resolved the wrong file learns which file to read.
    """

    def __init__(self, model_id: str, path: str, known: Tuple[str, ...]) -> None:
        message = (
            "No model '"
            + model_id
            + "' in the registry at '"
            + path
            + "'; known ids: "
            + (", ".join(known) if known else "(none)")
        )
        super().__init__(message)
        self.model_id = model_id
        self.path = path
        self.known_model_ids = known


def _refuse(model_id: str, field: str, reason: str) -> ModelRecordError:
    return ModelRecordError(model_id, field, reason)


def _require_mapping(value: Any, path: str, model_id: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _refuse(model_id, path, "expected an object")
    return value


def _require_present(record: Mapping[str, Any], field: str, path: str, model_id: str) -> Any:
    if field not in record:
        raise _refuse(model_id, path, "the record does not carry this field")
    return record[field]


def _require_str(
    record: Mapping[str, Any],
    field: str,
    path: str,
    model_id: str,
    *,
    allow_empty: bool = False,
) -> str:
    value = _require_present(record, field, path, model_id)
    if not isinstance(value, str):
        raise _refuse(model_id, path, "expected a string, got " + type(value).__name__)
    if not allow_empty and not value:
        raise _refuse(model_id, path, "expected a non-empty string")
    return value


def _require_bool(record: Mapping[str, Any], field: str, path: str, model_id: str) -> bool:
    value = _require_present(record, field, path, model_id)
    if not isinstance(value, bool):
        raise _refuse(model_id, path, "expected a boolean, got " + type(value).__name__)
    return value


def _require_positive_int(
    record: Mapping[str, Any], field: str, path: str, model_id: str
) -> int:
    value = _require_present(record, field, path, model_id)
    if isinstance(value, bool) or not isinstance(value, int):
        raise _refuse(model_id, path, "expected an integer, got " + type(value).__name__)
    if value < 1:
        raise _refuse(model_id, path, "expected a number greater than 0")
    return value


def _require_str_list(
    record: Mapping[str, Any],
    field: str,
    path: str,
    model_id: str,
    *,
    min_items: int = 0,
    vocabulary: Sequence[str] | None = None,
) -> Tuple[str, ...]:
    value = _require_present(record, field, path, model_id)
    if not isinstance(value, (list, tuple)):
        raise _refuse(model_id, path, "expected a list of strings")
    items: List[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item:
            raise _refuse(
                model_id,
                path + "." + str(index),
                "expected a non-empty string",
            )
        if vocabulary is not None and item not in vocabulary:
            raise _refuse(
                model_id,
                path + "." + str(index),
                "expected one of " + "|".join(vocabulary) + ", got '" + item + "'",
            )
        items.append(item)
    if len(items) < min_items:
        raise _refuse(
            model_id, path, "expected at least " + str(min_items) + " item(s)"
        )
    return tuple(items)


def _require_url(record: Mapping[str, Any], field: str, path: str, model_id: str) -> str:
    value = _require_str(record, field, path, model_id)
    if not is_absolute_url(value):
        raise _refuse(model_id, path, "expected an absolute URL with a host")
    return value


def _refuse_unknown_keys(
    record: Mapping[str, Any], allowed: Sequence[str], path: str, model_id: str
) -> None:
    for key in record:
        if key not in allowed:
            raise _refuse(
                model_id,
                (path + "." + key) if path else key,
                "the record carries a field the registry does not define",
            )


def _require_nested(
    value: Any,
    path: str,
    model_id: str,
    allowed: Sequence[str],
) -> Mapping[str, Any]:
    nested = _require_mapping(value, path, model_id)
    _refuse_unknown_keys(nested, allowed, path, model_id)
    return nested


def record_from_mapping(raw: Mapping[str, Any], path: str = "models.0") -> ModelRecord:
    """Build a {@link ModelRecord} from its registry entry.

    Every refusal names the offending field by its path in the file, and the
    record is never built from a partial mapping: a field that is absent is a
    refusal, not a default.
    """
    entry = _require_mapping(raw, path, "(unknown)")
    model_id_value = entry.get("modelId")
    model_id = model_id_value if isinstance(model_id_value, str) and model_id_value else "(unknown)"
    _refuse_unknown_keys(entry, RECORD_FIELDS, path, model_id)

    strings = {}
    for field in STRING_FIELDS:
        strings[field] = _require_str(
            entry,
            field,
            path + "." + field,
            model_id,
            allow_empty=field not in NON_EMPTY_STRING_FIELDS,
        )

    if strings["revision"] == "latest":
        raise _refuse(
            model_id,
            path + ".revision",
            "the floating revision 'latest' can never back a saved run; pin an exact "
            "revision",
        )
    digest = strings["sourceDigest"]
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise _refuse(
            model_id,
            path + ".sourceDigest",
            "expected a 64-character lowercase sha256 digest, got '" + digest + "'",
        )

    urls = {}
    for field in URL_FIELDS:
        urls[field] = _require_url(entry, field, path + "." + field, model_id)

    commercial_use = _require_bool(entry, "commercialUse", path + ".commercialUse", model_id)

    required_extras = _require_str_list(
        entry, "requiredExtras", path + ".requiredExtras", model_id
    )
    tasks = _require_str_list(entry, "tasks", path + ".tasks", model_id, min_items=1)
    device_support = _require_str_list(
        entry,
        "deviceSupport",
        path + ".deviceSupport",
        model_id,
        min_items=1,
        vocabulary=DEVICE_SUPPORT,
    )

    size = _require_nested(
        _require_present(entry, "inputImageSize", path + ".inputImageSize", model_id),
        path + ".inputImageSize",
        model_id,
        INPUT_IMAGE_SIZE_FIELDS,
    )
    width = _require_positive_int(
        size, "width", path + ".inputImageSize.width", model_id
    )
    height = _require_positive_int(
        size, "height", path + ".inputImageSize.height", model_id
    )

    shape = _require_nested(
        _require_present(entry, "outputShape", path + ".outputShape", model_id),
        path + ".outputShape",
        model_id,
        OUTPUT_SHAPE_FIELDS,
    )
    dimension = _require_positive_int(
        shape, "dimension", path + ".outputShape.dimension", model_id
    )

    return ModelRecord(
        model_id=strings["modelId"],
        revision=strings["revision"],
        source_uri=urls["sourceUri"],
        source_digest=digest,
        license=strings["license"],
        license_url=urls["licenseUrl"],
        commercial_use=commercial_use,
        usage_restrictions=strings["usageRestrictions"],
        required_extras=required_extras,
        tasks=tasks,
        preprocessing_fingerprint=strings["preprocessingFingerprint"],
        device_support=device_support,
        input_image_size=(width, height),
        feature_extractor=strings["featureExtractor"],
        output_dimension=dimension,
        latency_cost_profile=strings["latencyCostProfile"],
        calibration_status=strings["calibrationStatus"],
        trust_policy=strings["trustPolicy"],
        attribution=strings["attribution"],
        notes=strings["notes"],
    )


@dataclass(frozen=True)
class ModelCapabilityRegistry:
    """The model capability records of one registry file."""

    path: str
    records: Tuple[ModelRecord, ...]

    def model_ids(self) -> Tuple[str, ...]:
        """Return the known model ids in sorted order."""
        return tuple(sorted(record.model_id for record in self.records))

    def resolve(self, model_id: str) -> ModelRecord:
        """Resolve a model id to its record.

        @raises ModelNotFoundError when no record carries that id.
        """
        for record in self.records:
            if record.model_id == model_id:
                return record
        raise ModelNotFoundError(model_id, self.path, self.model_ids())

    def __contains__(self, model_id: object) -> bool:
        return any(record.model_id == model_id for record in self.records)

    def __len__(self) -> int:
        return len(self.records)


def load_model_registry(path: str) -> ModelCapabilityRegistry:
    """Read the model capability records of a registry file.

    The file is read as it is; nothing is fetched. A registry without a
    `models` array is a registry that resolves no encoder: an empty registry,
    never a default one.
    """
    target = Path(path)
    try:
        text = target.read_text(encoding="utf8")
    except OSError as error:
        raise ModelRegistryError(
            str(target), "the file cannot be read: " + str(error), None
        ) from None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ModelRegistryError(
            str(target), "the file is not valid JSON: " + str(error), None
        ) from None
    if not isinstance(parsed, Mapping):
        raise ModelRegistryError(str(target), "the file is not a registry object", None)

    for key in parsed:
        if key not in REGISTRY_FIELDS:
            raise ModelRegistryError(
                str(target),
                "the file carries a field the registry does not define",
                key,
            )

    version = parsed.get("schemaVersion")
    if isinstance(version, bool) or not isinstance(version, int):
        raise ModelRegistryError(
            str(target),
            "the registry format version must be an integer, got "
            + type(version).__name__,
            "schemaVersion",
        )
    if version not in READABLE_SCHEMA_VERSIONS:
        raise ModelRegistryError(
            str(target),
            "the registry format version "
            + repr(version)
            + " is not one this module reads ("
            + ", ".join(str(item) for item in READABLE_SCHEMA_VERSIONS)
            + ")",
            "schemaVersion",
        )

    datasets = parsed.get("datasets")
    if not isinstance(datasets, list):
        raise ModelRegistryError(
            str(target), "the datasets array is not a list", "datasets"
        )
    if len(datasets) < 1:
        raise ModelRegistryError(
            str(target), "the datasets array is empty", "datasets"
        )
    for index, raw_dataset in enumerate(datasets):
        try:
            validate_dataset_entry(raw_dataset, "datasets." + str(index))
        except DatasetEntryError as error:
            raise ModelRegistryError(
                str(target), error.reason, error.field
            ) from None

    raw_models = parsed.get("models", [])
    if not isinstance(raw_models, list):
        raise ModelRegistryError(
            str(target), "the models array is not a list", "models"
        )
    if version == 1 and len(raw_models) > 0:
        raise ModelRegistryError(
            str(target),
            "a version 1 registry carries no model records; the models array belongs to "
            "format version 2",
            "models",
        )

    records: List[ModelRecord] = []
    for index, raw in enumerate(raw_models):
        if not isinstance(raw, Mapping):
            raise ModelRegistryError(
                str(target), "a model record is not an object", "models." + str(index)
            )
        records.append(record_from_mapping(raw, "models." + str(index)))

    return ModelCapabilityRegistry(path=str(target), records=tuple(records))


def resolve_model(registry: ModelCapabilityRegistry, model_id: str) -> ModelRecord:
    """Resolve a model id in a loaded registry.

    @raises ModelNotFoundError when no record carries that id.
    """
    return registry.resolve(model_id)


def model_records_by_id(
    registry: ModelCapabilityRegistry,
) -> Dict[str, ModelRecord]:
    """Return the records of a registry keyed by their model id."""
    return {record.model_id: record for record in registry.records}
