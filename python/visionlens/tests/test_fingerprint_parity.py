"""Fingerprint parity: the Python encoder reproduces the TypeScript fp2 digests.

Spec 019 requires the fingerprint algorithm to be byte-identical across the
two languages. The canonical form lives in packages/contracts/src/fingerprint.ts:
recursively key-sorted JSON with compact separators, arrays keeping their
order, sha256 over the UTF-8 bytes, the first 16 hex characters, the fp2:
prefix. Every expected literal below was computed by that live TypeScript
implementation, once, with:

    PATH=/tmp/pnpm11:$PATH pnpm exec tsx /tmp/fp_parity/gen.ts

which imports canonicalJson and fingerprintV2 from
packages/contracts/src/fingerprint.ts, hashes the same payloads and prints
the canonical JSON, the sha256 hex digest and the fp2 form. The literals are
pinned so a drift on either side fails this file. The payloads are the family
both sides actually digest (ASCII strings, ints, fractional floats, booleans,
null, nested objects, ordered arrays); outside that family the serializers
differ (Python escapes non-ASCII through ensure_ascii while JSON.stringify
emits it raw), so non-ASCII never enters a fingerprint payload.
"""

from __future__ import annotations

from typing import Any

import pytest
from helpers import SRC  # noqa: F401  (path setup)

from visionlens.encoder import (
    PREPROCESSING_COMPONENTS,
    canonical_json,
    digest_of,
    preprocessing_fingerprint,
)
from visionlens.registry import ModelRegistry

#: The full-config input shape of fingerprintV2 (spec 019 tier 1), carrying
#: the same slots the TypeScript fingerprint test uses.
FINGERPRINT_INPUT: dict[str, Any] = {
    "model": "openai/gpt-4o",
    "promptTemplate": "prompt-v1",
    "taxonomy": [
        {"name": "kitchen", "description": "Kitchen area with counters and appliances"},
        {"name": "bathroom", "description": "Bathroom with fixtures"},
    ],
    "preprocessing": {"resize": 1024, "detail": "high"},
    "dataVersion": "legacy-v2",
    "contractsVersion": "0.2.0",
}

#: One row per payload: (payload, canonical JSON, sha256 hex, fp2 form).
#: The last three columns are TypeScript output, not hand-derived; the
#: fingerprint_input row's fp2 column equals a direct fingerprintV2() call.
PARITY_TABLE: list[tuple[str, dict[str, Any], str, str]] = [
    (
        {},
        "{}",
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        "fp2:44136fa355b3678a",
    ),
    (
        {"preprocessing": PREPROCESSING_COMPONENTS},
        '{"preprocessing":{"interpolation":"bilinear","normalize":{"mean":[0.5,0.5,0.5],'
        '"std":[0.5,0.5,0.5]},"rescale":{"factor":0.00392156862745098},'
        '"resize":{"crop":[256,256],"shortestEdge":256}}}',
        "b954b202e7527fc51b1f60d83389c529cae581851063bb31330819206588028e",
        "fp2:b954b202e7527fc5",
    ),
    (
        {
            "model": "siglip2-base",
            "nested": {"z": {"y": [1, 2], "x": None}, "flag": True, "off": False},
            "revision": "r1",
            "neg": -7,
        },
        '{"model":"siglip2-base","neg":-7,"nested":{"flag":true,"off":false,'
        '"z":{"x":null,"y":[1,2]}},"revision":"r1"}',
        "8480ef9e3b9afd2db5d14728ad613755aa4ccbc0d16ede51d43f76d24a2dfb27",
        "fp2:8480ef9e3b9afd2d",
    ),
    (
        {
            "taxonomy": [
                {"name": "kitchen", "description": "Kitchen area"},
                {"name": "bath", "description": "Bathroom"},
            ]
        },
        '{"taxonomy":[{"description":"Kitchen area","name":"kitchen"},'
        '{"description":"Bathroom","name":"bath"}]}',
        "e181f9bee16b758e19d8a44dbd08104e799a8c11b43244cbbcaae942ad5d8177",
        "fp2:e181f9bee16b758e",
    ),
    (
        {
            "taxonomy": [
                {"name": "bath", "description": "Bathroom"},
                {"name": "kitchen", "description": "Kitchen area"},
            ]
        },
        '{"taxonomy":[{"description":"Bathroom","name":"bath"},'
        '{"description":"Kitchen area","name":"kitchen"}]}',
        "c7ad4db8a2851e90d51df5c81a3aba913749cd56ff463e8dce1fdcca0c99d06f",
        "fp2:c7ad4db8a2851e90",
    ),
    (
        FINGERPRINT_INPUT,
        '{"contractsVersion":"0.2.0","dataVersion":"legacy-v2","model":"openai/gpt-4o",'
        '"preprocessing":{"detail":"high","resize":1024},"promptTemplate":"prompt-v1",'
        '"taxonomy":[{"description":"Kitchen area with counters and appliances",'
        '"name":"kitchen"},{"description":"Bathroom with fixtures","name":"bathroom"}]}',
        "e193cd0eeda37fbdd29755fb293b2c414eb9904d65b0cd48cdfc3addd93b43ee",
        "fp2:e193cd0eeda37fbd",
    ),
    (
        {
            "band": [
                1e-7,
                1e-6,
                1e-5,
                1e-4,
                1e20,
                1e21,
                1.5e21,
                2.5e-7,
                5e-324,
                1.7976931348623157e308,
                9.999999999999999e20,
            ],
            "single": 0.000001,
        },
        '{"band":[1e-7,0.000001,0.00001,0.0001,100000000000000000000,1e+21,1.5e+21,'
        '2.5e-7,5e-324,1.7976931348623157e+308,999999999999999900000],'
        '"single":0.000001}',
        "46fdd141185b4033118f9a02a94e754d8731a6a798f0402463cf5194fe8c4a88",
        "fp2:46fdd141185b4033",
    ),
]


def fp2_of(payload: dict[str, Any]) -> str:
    """Apply the fingerprintV2 digest shape to a payload, the Python way."""
    return "fp2:" + digest_of(payload)[:16]


@pytest.mark.parametrize(
    "payload,canonical,sha256,fp2",
    PARITY_TABLE,
    ids=["empty", "preprocessing", "nested", "array-order-a", "array-order-b", "full-config", "number-band"],
)
def test_python_reproduces_the_typescript_digests(
    payload: dict[str, Any], canonical: str, sha256: str, fp2: str
) -> None:
    assert canonical_json(payload) == canonical
    assert digest_of(payload) == sha256
    assert fp2_of(payload) == fp2


def test_object_key_order_does_not_change_the_digest() -> None:
    reordered = {key: FINGERPRINT_INPUT[key] for key in reversed(list(FINGERPRINT_INPUT))}
    assert digest_of(reordered) == digest_of(FINGERPRINT_INPUT)
    assert fp2_of(reordered) == "fp2:e193cd0eeda37fbd"


def test_array_order_is_load_bearing() -> None:
    taxonomy_a, _, digest_a, fp2_a = PARITY_TABLE[3]
    taxonomy_b, _, digest_b, fp2_b = PARITY_TABLE[4]
    assert digest_a != digest_b
    assert fp2_a != fp2_b
    assert taxonomy_a["taxonomy"][0]["name"] == "kitchen"
    assert taxonomy_b["taxonomy"][0]["name"] == "bath"


def test_encoder_preprocessing_fingerprint_is_the_typescript_digest() -> None:
    spec = ModelRegistry.default().resolve("siglip2-base")
    assert preprocessing_fingerprint(spec) == "fp2:b954b202e7527fc5"
    assert preprocessing_fingerprint(spec) == fp2_of({"preprocessing": PREPROCESSING_COMPONENTS})


def test_full_config_digest_matches_fingerprint_v2() -> None:
    # The pinned literal came from a direct fingerprintV2(FINGERPRINT_INPUT)
    # call on the TypeScript side, so this row pins the whole spec 019 tier 1
    # scope: model, promptTemplate, taxonomy, preprocessing, dataVersion and
    # contractsVersion in one digest.
    assert fp2_of(FINGERPRINT_INPUT) == "fp2:e193cd0eeda37fbd"
