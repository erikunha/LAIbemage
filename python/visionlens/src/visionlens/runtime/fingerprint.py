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
  - the NUMBERS are written the way JavaScript writes them: the shortest
    digits that read back as the same value, the exponential form below
    1e-6 and from 1e21, and an exponent that always carries its sign.

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

    The rule is the one of `Number::toString` in the language
    specification, and it is not the rule of Python: a value whose
    decimal exponent is below -6 or at least 21 is written in the
    exponential form, the exponent always carries its sign, and the
    digits are the shortest ones that read back as the same value.

    A value that is not a number is the JSON null, the way
    `JSON.stringify` writes it.
    """
    if value != value or value in (float("inf"), float("-inf")):
        return "null"
    if value == 0:
        # JavaScript writes the negative zero as a zero.
        return "0"
    negative = value < 0
    digits, exponent = _shortest_digits(abs(value))
    text = _decimal(digits, exponent)
    return "-" + text if negative else text


def _shortest_digits(value: float) -> tuple[str, int]:
    """The shortest digits of a positive value and its decimal exponent.

    The result is the digit string without its trailing zeros and the
    exponent `n` of the specification, so the value is
    `0.<digits> * 10 ** n`.
    """
    text = repr(value)
    if "e" in text:
        mantissa, _, exponent_text = text.partition("e")
        exponent = int(exponent_text)
    else:
        mantissa = text
        exponent = 0
    if "." in mantissa:
        int_part, _, frac_part = mantissa.partition(".")
    else:
        int_part, frac_part = mantissa, ""
    # The digits of the value, without the leading zeros, which carry no
    # value, and without the trailing ones, which the exponent carries.
    plain = str(int(int_part + frac_part))
    trailing = len(plain) - len(plain.rstrip("0"))
    digits = plain.rstrip("0")
    # `value == digits * 10 ** (n - len(digits))`, and the fraction of the
    # repr carries the exponent of the fraction.
    n = len(digits) + trailing + exponent - len(frac_part)
    return digits, n


def _decimal(digits: str, n: int) -> str:
    """The decimal form of the digits, the way the specification writes it."""
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    exponent = n - 1
    sign = "+" if exponent >= 0 else "-"
    head = digits if k == 1 else digits[0] + "." + digits[1:]
    return head + "e" + sign + str(abs(exponent))


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
