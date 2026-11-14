"""The manifest, validated against the JSON Schema of the contract.

The manifest of a run is a contract between two languages: the Python
runtime writes it and the TypeScript side validates it. The schema is
generated from the same Zod schema the TypeScript side validates with
(`packages/core/src/adapter/embedding-manifest.ts`), and the validator
here reads the generated file, so the two languages cannot drift
(`docs/vnext/07-CONTRACTS-PROTOCOL.md:5`, `:74`).

The validator covers the SUBSET of JSON Schema the manifest schema
uses: objects, arrays, strings, numbers, integers, booleans, the
required list, the property names, the patterns, the bounds and the
`anyOf` union. It is not a general JSON Schema implementation, and it
says so when it meets a keyword it does not know.

Two rules are the rules of the other side and not of this document: a
pattern is matched against the WHOLE value (the patterns of this schema
are anchored, and the JavaScript validator matches the whole value too),
and an integer is a number with no fractional part, so `6.0` is an
integer and `6.5` is not. The two validators therefore refuse the same
payloads, which is the property the parity gate proves.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence
from urllib.parse import urlparse

#: The keywords this validator understands. A schema that uses another
#: one is a schema this validator refuses, never a schema it ignores.
SUPPORTED_KEYWORDS = frozenset(
    {
        "$schema",
        "type",
        "properties",
        "required",
        "additionalProperties",
        "propertyNames",
        "items",
        "pattern",
        "minLength",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "const",
        "anyOf",
        "format",
        "description",
        "title",
    }
)


class UnsupportedSchemaError(ValueError):
    """The schema uses a keyword this validator does not know."""


def load_manifest_schema(path: Path) -> Dict[str, Any]:
    """The JSON Schema of the manifest, read from the generated file.

    @raises ValueError when the file is not a JSON object.
    """
    payload = json.loads(Path(path).read_text(encoding="utf8"))
    if not isinstance(payload, dict):
        raise ValueError("the manifest schema is not a JSON object")
    return payload


def validate_against_schema(
    payload: Any, schema: Mapping[str, Any], path: str = ""
) -> List[str]:
    """The issues of a payload against a schema, in the order they appear.

    @raises UnsupportedSchemaError when the schema uses an unknown keyword.
    """
    unknown = set(schema.keys()) - SUPPORTED_KEYWORDS
    if unknown:
        raise UnsupportedSchemaError(
            "the schema at '"
            + (path or "(root)")
            + "' uses the keywords "
            + ", ".join(sorted(unknown))
            + ", which this validator does not know"
        )
    issues: List[str] = []
    where = path or "(root)"

    if "const" in schema and payload != schema["const"]:
        issues.append(f"{where}: expected the constant {schema['const']!r}")
        return issues

    expected = schema.get("type")
    if expected is not None and not _matches_type(payload, expected):
        issues.append(f"{where}: expected the type {expected}")
        return issues

    if "anyOf" in schema:
        branches: Sequence[Mapping[str, Any]] = schema["anyOf"]
        if all(validate_against_schema(payload, branch, path) for branch in branches):
            issues.append(f"{where}: the value matches none of the allowed forms")
        return issues

    if isinstance(payload, str):
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.fullmatch(pattern, payload) is None:
            issues.append(f"{where}: the value does not match the pattern {pattern}")
        minimum_length = schema.get("minLength")
        if isinstance(minimum_length, int) and len(payload) < minimum_length:
            issues.append(f"{where}: the value is shorter than {minimum_length}")
        fmt = schema.get("format")
        if fmt == "uri" and not _is_absolute_url(payload):
            issues.append(f"{where}: the value is not an absolute URL")
        return issues

    if isinstance(payload, bool):
        return issues
    if isinstance(payload, (int, float)):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        exclusive = schema.get("exclusiveMinimum")
        if isinstance(minimum, (int, float)) and payload < minimum:
            issues.append(f"{where}: the value is below {minimum}")
        if isinstance(maximum, (int, float)) and payload > maximum:
            issues.append(f"{where}: the value is above {maximum}")
        if isinstance(exclusive, (int, float)) and payload <= exclusive:
            issues.append(f"{where}: the value is not above {exclusive}")
        return issues

    if isinstance(payload, list):
        items = schema.get("items")
        if isinstance(items, Mapping):
            for index, item in enumerate(payload):
                issues.extend(
                    validate_against_schema(item, items, f"{where}[{index}]")
                )
        return issues

    if isinstance(payload, Mapping):
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in payload:
                issues.append(f"{where}: the field {name} is missing")
        names_schema = schema.get("propertyNames")
        if isinstance(names_schema, Mapping):
            for name in payload:
                issues.extend(
                    validate_against_schema(name, names_schema, f"{where}.{name}")
                )
        additional = schema.get("additionalProperties", True)
        for name, value in payload.items():
            child = f"{where}.{name}"
            if name in properties:
                issues.extend(
                    validate_against_schema(value, properties[name], child)
                )
            elif additional is False:
                issues.append(f"{child}: the field is not one the schema names")
            elif isinstance(additional, Mapping):
                issues.extend(validate_against_schema(value, additional, child))
        return issues

    return issues


def _matches_type(payload: Any, expected: Any) -> bool:
    """Whether a payload is of the type the schema names."""
    names = expected if isinstance(expected, list) else [expected]
    for name in names:
        if name == "object" and isinstance(payload, Mapping):
            return True
        if name == "array" and isinstance(payload, list):
            return True
        if name == "string" and isinstance(payload, str):
            return True
        if name == "boolean" and isinstance(payload, bool):
            return True
        if (
            name == "integer"
            and isinstance(payload, (int, float))
            and not isinstance(payload, bool)
            and float(payload).is_integer()
        ):
            # An integer is a NUMBER with no fractional part, the way the
            # JSON Schema defines it: `6.0` is an integer and `6.5` is
            # not. The JavaScript side has one number type, so it agrees.
            return True
        if name == "number" and isinstance(payload, (int, float)) and not isinstance(payload, bool):
            return True
        if name == "null" and payload is None:
            return True
    return False


def _is_absolute_url(value: str) -> bool:
    """Whether a value is an absolute URL.

    A scheme and a host, the way the URL of the other side is checked: a
    value that carries no host, or a scheme that is not one of the
    network ones, is not a URL.
    """
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https"):
        return False
    return bool(parsed.netloc)


def manifest_schema_path(repo_root: Path) -> Path:
    """The path of the generated manifest schema in the repository."""
    return (
        Path(repo_root)
        / "packages"
        / "core"
        / "src"
        / "adapter"
        / "embedding-manifest.schema.json"
    )


def validate_manifest_file(path: Path, schema_path: Optional[Path] = None) -> List[str]:
    """The issues of a manifest file against the generated schema."""
    schema_file = schema_path or manifest_schema_path(Path.cwd())
    schema = load_manifest_schema(schema_file)
    payload = json.loads(Path(path).read_text(encoding="utf8"))
    return validate_against_schema(payload, schema)
