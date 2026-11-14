"""Generate the golden file and the golden artifact of the vision adapter.

The golden file is the pinned fact of one model over the golden set: the
images with their digests, the golden vectors, the fingerprints and the
tolerance. The artifact beside it is the run that produced them, so the
parity gate has something to validate on a machine that cannot run the
model.

The tolerance is MEASURED, not guessed: the same images are embedded
twice, once in one batch and once one image at a time, and the largest
difference between the two runs and the smallest cosine similarity are
the numbers the golden file carries. The batch changes the order of the
accumulation of the matrix products, so the difference is the numerical
variation of the run and not a difference of the inputs.

    uv run --group dev python scripts/generate_golden.py

The command needs the `vision` extra (torch and transformers) and the
model in the cache. It writes:

    benchmarks/parity/vision-embed.golden.json
    benchmarks/parity/vision-embed.artifact/manifest.json
    benchmarks/parity/vision-embed.artifact/vectors.f32
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from visionlens.encoders.siglip2 import Siglip2Encoder  # noqa: E402
from visionlens.inference.artifact import (  # noqa: E402
    read_embedding_artifact,
)
from visionlens.inference.batching import BatchScheduler  # noqa: E402
from visionlens.inference.embedder import (  # noqa: E402
    EmbedAsset,
    EmbedRequest,
    VisionEmbedder,
)
from visionlens.io.decode import DecodeService  # noqa: E402
from visionlens.io.preprocess import PreprocessingSpec  # noqa: E402
from visionlens.registry.loader import load_model_registry  # noqa: E402
from visionlens.runtime.device import DevicePlanner  # noqa: E402
from visionlens.runtime.fingerprint import fingerprint_v2  # noqa: E402

#: The fixtures of the golden set: the committed 100x100 images.
FIXTURES_DIR = REPO_ROOT / "packages" / "core" / "tests" / "fixtures" / "images"

#: The snapshot the golden set belongs to.
SNAPSHOT_ID = "fixtures-2026-11-15"

#: Where the golden file and the golden artifact live.
PARITY_DIR = REPO_ROOT / "benchmarks" / "parity"
GOLDEN_PATH = PARITY_DIR / "vision-embed.golden.json"
ARTIFACT_DIR = PARITY_DIR / "vision-embed.artifact"

#: The prompt template version of a run that has no prompt.
PROMPT_TEMPLATE = "none"


def contracts_version() -> str:
    """The version of the contracts package, read from the repository."""
    payload = json.loads(
        (REPO_ROOT / "packages" / "contracts" / "package.json").read_text(encoding="utf8")
    )
    return str(payload["version"])


def build_config(record: Any, spec: PreprocessingSpec) -> Dict[str, Any]:
    """The configuration a run is fingerprinted over.

    The shape is the one the live TypeScript `FingerprintInput` has, so
    the same object is fingerprinted by both languages.
    """
    return {
        "model": record.model_id + "@" + record.revision,
        "promptTemplate": PROMPT_TEMPLATE,
        "taxonomy": [],
        "preprocessing": spec.components(),
        "dataVersion": SNAPSHOT_ID,
        "contractsVersion": contracts_version(),
    }


def embed_once(
    record: Any,
    spec: PreprocessingSpec,
    model_dir: Path,
    batch_size: int,
    workdir: Path,
) -> Any:
    """Run the embedding once, with the given batch size."""
    fixtures = sorted(FIXTURES_DIR.glob("*.jpg"))
    plan = DevicePlanner().plan("cpu")
    embedder = VisionEmbedder(
        record=record,
        encoder=Siglip2Encoder(record, model_dir, plan),
        spec=spec,
        decoder=DecodeService(FIXTURES_DIR),
        device=plan,
        artifact_root=workdir,
        scheduler=BatchScheduler(max_batch_size=batch_size, min_batch_size=1),
        snapshot_id=SNAPSHOT_ID,
    )
    result = embedder.embed(
        EmbedRequest(
            snapshot_id=SNAPSHOT_ID,
            assets=tuple(EmbedAsset(asset_id=path.name, path=path) for path in fixtures),
        )
    )
    if result.errors:
        raise SystemExit("the golden run reported errors: " + str(result.errors))
    return result


def vectors_of(artifact_dir: Path) -> List[List[float]]:
    """The vectors of an artifact, in the order of the images."""
    import array

    artifact = read_embedding_artifact(artifact_dir)
    payload = array.array("f")
    payload.frombytes(artifact.vectors_path.read_bytes())
    dimension = artifact.manifest.dimension
    return [list(payload[index * dimension : (index + 1) * dimension]) for index in range(len(payload) // dimension)]


def vectors_digest(images: List[Dict[str, Any]]) -> str:
    """The digest of the golden set.

    The digest covers the name and the file digest of every image and
    the float32 BYTES of its vector. The bytes, and not the JSON of the
    numbers, because the two languages write a float differently: the
    bytes of a float32 are the same on both sides and the JSON is not.
    """
    import array
    import sys

    payload = bytearray()
    for image in images:
        payload += str(image["name"]).encode("utf-8") + b"\x00"
        payload += str(image["sha256"]).encode("utf-8") + b"\x00"
        packed = array.array("f", (float(value) for value in image["vector"]))
        if sys.byteorder != "little":
            packed.byteswap()
        payload += packed.tobytes()
    return hashlib.sha256(bytes(payload)).hexdigest()


def cosine(left: List[float], right: List[float]) -> float:
    """The cosine similarity of two vectors."""
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = sum(a * a for a in left) ** 0.5
    right_norm = sum(b * b for b in right) ** 0.5
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def main() -> int:
    """Write the golden file and the golden artifact."""
    record = load_model_registry(REPO_ROOT / "datasets" / "registry.json").resolve("siglip2-base")
    model_dir = (
        Path.home() / ".cache" / "visionlens" / "models" / record.model_id / record.revision
    )
    if not (model_dir / "model.safetensors").is_file():
        raise SystemExit(
            "the model is not in the cache: run the weights loader for the record first"
        )
    spec = PreprocessingSpec.from_preprocessor_config(
        json.loads((model_dir / "preprocessor_config.json").read_text(encoding="utf8"))
    )

    workdir = Path("/tmp/visionlens-golden")
    shutil.rmtree(workdir, ignore_errors=True)
    batched = embed_once(record, spec, model_dir, 8, workdir / "batched")
    single = embed_once(record, spec, model_dir, 1, workdir / "single")

    batched_vectors = vectors_of(batched.artifact_path)
    single_vectors = vectors_of(single.artifact_path)
    if len(batched_vectors) != len(single_vectors):
        raise SystemExit("the two runs embedded a different number of images")
    differences = [
        max(abs(a - b) for a, b in zip(left, right))
        for left, right in zip(batched_vectors, single_vectors)
    ]
    similarities = [cosine(left, right) for left, right in zip(batched_vectors, single_vectors)]
    measured_max = max(differences)
    measured_min = min(similarities)

    fixtures = sorted(FIXTURES_DIR.glob("*.jpg"))
    images = []
    for path, vector in zip(fixtures, batched_vectors):
        images.append(
            {
                "name": path.name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                # The golden vector is rounded to six decimals, and the
                # tolerance covers the rounding and the numerical
                # variation of the run.
                "vector": [round(value, 6) for value in vector],
            }
        )

    config = build_config(record, spec)
    golden = {
        "schemaVersion": 1,
        "generatedAt": "2026-11-14T18:00:00.000Z",
        "model": {
            "modelId": record.model_id,
            "revision": record.revision,
            "sourceUri": record.source_uri,
            "weightsDigest": record.source_digest,
        },
        "preprocessing": {
            "fingerprint": spec.fingerprint(),
            "components": spec.components(),
        },
        "config": config,
        "configFingerprint": fingerprint_v2(config),
        "tolerance": {
            "maxAbsoluteDifference": 0.001,
            "minCosineSimilarity": 0.9999,
            "reason": (
                "measured on the CPU run of 2026-11-14: the same images embedded in one "
                "batch and one image at a time differ by at most "
                + format(measured_max, ".3e")
                + " with a cosine similarity of at least "
                + format(measured_min, ".9f")
                + ". The bound carries a margin of an order of magnitude over the "
                "measured variation, and widening it is a visible diff."
            ),
        },
        "images": images,
    }
    golden["vectorsDigest"] = vectors_digest(images)

    PARITY_DIR.mkdir(parents=True, exist_ok=True)
    GOLDEN_PATH.write_text(json.dumps(golden, indent=2) + "\n", encoding="utf8")

    shutil.rmtree(ARTIFACT_DIR, ignore_errors=True)
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    source = batched.artifact_path
    shutil.copy2(source / "manifest.json", ARTIFACT_DIR / "manifest.json")
    shutil.copy2(source / "vectors.f32", ARTIFACT_DIR / "vectors.f32")

    print("golden file:", GOLDEN_PATH)
    print("artifact:", ARTIFACT_DIR)
    print("images:", len(images))
    print("measured max difference:", format(measured_max, ".3e"))
    print("measured min cosine similarity:", format(measured_min, ".9f"))
    print("config fingerprint:", golden["configFingerprint"])
    print("vectors digest:", golden["vectorsDigest"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
