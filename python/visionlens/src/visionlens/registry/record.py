"""One model capability record, and the refusals it earns.

The record is the platform's knowledge of a model BEFORE it is used: which
bytes it is, which license it carries, which devices it runs on and which
exact revision it is. The shape follows the model capability registry design
in docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md.

Every refusal names the offending field, by the path the FILE uses
(`models.0.sourceDigest`, `models.0.inputImageSize.width`), not by the name
of a Python attribute. The field a maintainer has to fix lives in the file,
and the TypeScript reader names the same paths the same way, so one refusal
means one thing in both languages.

The rules here are the rules of the TypeScript reader
(`packages/core/src/benchmark/registry.ts`), field for field:

  - every field the file names is REQUIRED: a field that is absent is a
    refusal, never a default;
  - a field that carries the wrong type is a refusal: a reader that coerces
    accepts a record the other reader refuses, and `bool("false")` is True,
    so a string here would quietly claim a commercial use the license may
    forbid;
  - an unknown field is a refusal: a misspelled field nobody sees is a field
    nobody maintains;
  - a string that must not be empty is a refusal, and so is a device the
    vocabulary does not name.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping, Tuple
from urllib.parse import urlparse

#: The sha256 of the weights, in the shape a digest always has.
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

#: The revision that can never back a saved run.
_FLOATING_REVISION = "latest"

#: The devices a record may declare (the vocabulary of the pack).
DEVICE_SUPPORT: Tuple[str, ...] = ("cpu", "mps", "cuda")

#: Every field a record carries, and nothing else.
RECORD_FIELDS: Tuple[str, ...] = (
    "modelId",
    "revision",
    "sourceUri",
    "sourceDigest",
    "license",
    "licenseUrl",
    "commercialUse",
    "usageRestrictions",
    "requiredExtras",
    "tasks",
    "preprocessingFingerprint",
    "deviceSupport",
    "inputImageSize",
    "featureExtractor",
    "outputShape",
    "latencyCostProfile",
    "calibrationStatus",
    "trustPolicy",
    "attribution",
    "notes",
)

#: The fields that must carry a string. An empty string is allowed only
#: where the TypeScript reader allows it (`usageRestrictions`, `notes`).
STRING_FIELDS: Tuple[str, ...] = (
    "modelId",
    "revision",
    "sourceUri",
    "sourceDigest",
    "license",
    "licenseUrl",
    "usageRestrictions",
    "preprocessingFingerprint",
    "featureExtractor",
    "latencyCostProfile",
    "calibrationStatus",
    "trustPolicy",
    "attribution",
    "notes",
)

#: The string fields that must not be empty.
NON_EMPTY_STRING_FIELDS: Tuple[str, ...] = (
    "modelId",
    "revision",
    "sourceUri",
    "sourceDigest",
    "license",
    "licenseUrl",
    "preprocessingFingerprint",
    "featureExtractor",
    "latencyCostProfile",
    "calibrationStatus",
    "trustPolicy",
    "attribution",
)

#: The fields that must carry a list of non-empty strings.
STRING_LIST_FIELDS: Tuple[str, ...] = ("requiredExtras", "tasks", "deviceSupport")

#: The fields that must carry an absolute URL with a host.
URL_FIELDS: Tuple[str, ...] = ("sourceUri", "licenseUrl")

#: The fields of the nested input size, and nothing else.
INPUT_IMAGE_SIZE_FIELDS: Tuple[str, ...] = ("width", "height")

#: The fields of the nested output shape, and nothing else.
OUTPUT_SHAPE_FIELDS: Tuple[str, ...] = ("dimension",)


class ModelRecordError(Exception):
    """Raised when a model record cannot be trusted.

    The message names the offending field by its path in the file, so a
    caller learns what to fix instead of guessing which rule fired.
    """

    def __init__(self, model_id: str, field: str, reason: str) -> None:
        message = "model '" + model_id + "' has an unusable " + field + ": " + reason
        super().__init__(message)
        self.model_id = model_id
        self.field = field
        self.reason = reason


@dataclass(frozen=True)
class ModelRecord:
    """A resolved model capability record.

    A record is built by `record_from_mapping`, which refuses a mapping the
    rules above reject. The checks below are the same rules, kept here so a
    record built by hand cannot carry a value the file would refuse.
    """

    model_id: str
    revision: str
    source_uri: str
    source_digest: str
    license: str
    license_url: str
    commercial_use: bool
    usage_restrictions: str
    required_extras: Tuple[str, ...]
    tasks: Tuple[str, ...]
    preprocessing_fingerprint: str
    device_support: Tuple[str, ...]
    input_image_size: Tuple[int, int]
    feature_extractor: str
    output_dimension: int
    latency_cost_profile: str
    calibration_status: str
    trust_policy: str
    attribution: str
    notes: str

    def __post_init__(self) -> None:
        if not self.model_id:
            raise ModelRecordError("(unknown)", "modelId", "a record must name its model")
        if self.revision == _FLOATING_REVISION:
            raise ModelRecordError(
                self.model_id,
                "revision",
                "the floating revision 'latest' can never back a saved run; pin an exact "
                "revision",
            )
        if not self.revision:
            raise ModelRecordError(
                self.model_id, "revision", "a record must pin an exact revision"
            )
        if not _SHA256_PATTERN.match(self.source_digest):
            raise ModelRecordError(
                self.model_id,
                "sourceDigest",
                "expected a 64-character lowercase sha256 digest, got '"
                + self.source_digest
                + "'",
            )
        if not self.license:
            raise ModelRecordError(
                self.model_id,
                "license",
                "a model must record its license before use",
            )
        if not self.license_url:
            raise ModelRecordError(
                self.model_id, "licenseUrl", "a license must be readable somewhere"
            )
        if not self.device_support:
            raise ModelRecordError(
                self.model_id,
                "deviceSupport",
                "a record must name at least one device the model runs on",
            )
        for device in self.device_support:
            if device not in DEVICE_SUPPORT:
                raise ModelRecordError(
                    self.model_id,
                    "deviceSupport",
                    "expected one of "
                    + "|".join(DEVICE_SUPPORT)
                    + ", got '"
                    + device
                    + "'",
                )
        if not self.tasks:
            raise ModelRecordError(
                self.model_id, "tasks", "a record must name at least one task"
            )
        if self.output_dimension < 1:
            raise ModelRecordError(
                self.model_id,
                "outputShape.dimension",
                "the output dimension must be >= 1",
            )
        width, height = self.input_image_size
        if width < 1 or height < 1:
            raise ModelRecordError(
                self.model_id,
                "inputImageSize",
                "the input image size must be >= 1",
            )


def is_absolute_url(value: str) -> bool:
    """Whether a string is an absolute URL with a host.

    The weights location is the promise the digest hangs on, so a value that
    is not a location is a refusal, not a string.
    """
    parsed = urlparse(value)
    return bool(parsed.scheme) and bool(parsed.netloc)
