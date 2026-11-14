"""The fingerprint, byte-identical to the live TypeScript implementation.

Two languages have to agree on the fingerprint of a configuration, or the
fingerprint proves nothing. The TypeScript side computes it with
`fingerprintV2` (`packages/contracts/src/fingerprint.ts:51`), and this
module reproduces that computation byte for byte: the same canonical
JSON serialization with recursively sorted object keys, the arrays
keeping their order, the same sha256 and the same `fp2:` prefix with the
first sixteen hex characters.

The two differences between the serializers of the two languages are
handled here and not left to chance:

  - the KEYS are sorted by their UTF-16 code units, the way the
    TypeScript `Array.prototype.sort` orders them, and not by their code
    points;
  - the NUMBERS are written the way JavaScript writes them: an integral
    float is written without its fraction, and an exponent carries no
    padding.

A fingerprint nobody can recompute is a decoration, and the test that
compares this module with the live TypeScript one is the guard.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence

#: The prefix of every fingerprint of this repository.
FINGERPRINT_PREFIX = "fp2:"

#: The number of hex characters the fingerprint keeps.
FINGERPRINT_LENGTH = 16


def canonical_json(value: Any) -> str:
    """The canonical JSON of a value, as the TypeScript side writes it.

    The object keys are sorted by their UTF-16 code units, the arrays
    keep their order, and the numbers are written the way JavaScript
    writes them.
    """
    return _serialize(value)


def _serialize(value: Any) -> str:
    """The canonical JSON of one value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, Mapping):
        keys = sorted(value.keys(), key=_utf16_order)
        parts = []
        for key in keys:
            # Python has no `undefined`, so no key is dropped: a `None` is
            # the JSON null and it is written as one.
            parts.append(json.dumps(key, ensure_ascii=False) + ":" + _serialize(value[key]))
        return "{" + ",".join(parts) + "}"
    if isinstance(value, Sequence):
        return "[" + ",".join(_serialize(item) for item in value) + "]"
    raise TypeError("the value of type " + type(value).__name__ + " has no canonical form")


def _utf16_order(key: str) -> bytes:
    """The sort key of an object key: its UTF-16 code units.

    The bytes are big-endian, so the comparison is the comparison of the
    code units, the way the TypeScript sort orders them.
    """
    return key.encode("utf-16-be", errors="surrogatepass")


def _number(value: float) -> str:
    """The number as JavaScript writes it.

    An integral float is written without its fraction, and an exponent
    carries no padding: `1.0` is `1` and `1e-07` is `1e-7`.
    """
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("a fingerprint cannot carry a number that is not a number")
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    text = repr(value)
    if "e" in text:
        mantissa, _, exponent = text.partition("e")
        sign = "-" if exponent.startswith("-") else ""
        digits = exponent.lstrip("+-").lstrip("0") or "0"
        text = mantissa + "e" + sign + digits
    return text


def fingerprint_v2(components: Mapping[str, Any]) -> str:
    """The fingerprint of a configuration, in the `fp2:` form.

    The input is the same shape the TypeScript `FingerprintInput` has:
    the model, the prompt template version, the taxonomy, the
    preprocessing, the data version and the contracts version.

    @raises ValueError when the input is not an object.
    """
    if not isinstance(components, Mapping):
        raise ValueError("a fingerprint is computed over an object")
    canonical = _serialize(components)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return FINGERPRINT_PREFIX + digest[:FINGERPRINT_LENGTH]
