"""The content-addressed artifact of an embedding run.

The vectors of a run are a binary file beside a manifest. The manifest
is the descriptor: it says which model produced the vectors, which
revision, which preprocessing, which device, and it carries the digest
of the vectors file, so a reader can prove the bytes it reads are the
bytes that were produced.

The manifest carries every field of FR-011, and a value that does not
exist is `unknown` and never `0`
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:24`).

The artifact digest is the digest of the manifest's own content: the
canonical JSON of every field but the digest itself, so the digest can
be computed before the manifest is written.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from ..encoder import canonical_json

#: The schema version of the manifest this package writes.
MANIFEST_SCHEMA_VERSION = 1

#: The value of a measurement that does not exist. It is never a zero:
#: a zero is a measurement, and a measurement that was never taken is
#: not a measurement.
UNKNOWN = "unknown"

#: The kind of artifact this package writes.
ARTIFACT_KIND = "embedding"

#: The name of the vectors file inside the artifact directory.
VECTORS_FILE_NAME = "vectors.f32"

#: The name of the manifest inside the artifact directory.
MANIFEST_FILE_NAME = "manifest.json"

#: The fields the artifact digest covers: the CONTENT of the artifact.
#: The run id, the timestamp, the latency, the peak memory, the runtime
#: versions and the device describe the RUN, not the content, and two
#: runs of the same content share the address.
CONTENT_FIELDS: Tuple[str, ...] = (
    "schemaVersion",
    "modelId",
    "revision",
    "sourceUri",
    "weightsDigest",
    "preprocessingFingerprint",
    "preprocessingComponents",
    "snapshotId",
    "assetSha256",
    "count",
    "dimension",
    "dtype",
    "vectorsFileDigest",
)


def latency_percentiles(latencies_ms: Sequence[float]) -> Dict[str, Any]:
    """The latency percentiles of the run.

    The percentiles are the ones the hardware matrix names: p50 and p95
    per image, with the count of the images that were embedded.

    A run without a measurement records `unknown`, never `0`.
    """
    if not latencies_ms:
        return {"count": 0, "p50Ms": UNKNOWN, "p95Ms": UNKNOWN, "totalMs": UNKNOWN}
    ordered = sorted(latencies_ms)
    return {
        "count": len(ordered),
        "p50Ms": _percentile(ordered, 0.50),
        "p95Ms": _percentile(ordered, 0.95),
        "totalMs": round(sum(ordered), 3),
    }


def _percentile(ordered: Sequence[float], fraction: float) -> float:
    """The percentile of an ordered list, by the nearest-rank method."""
    if not ordered:
        return 0.0
    index = max(0, min(len(ordered) - 1, int(round(fraction * len(ordered) + 0.5)) - 1))
    return round(ordered[index], 3)


@dataclass(frozen=True)
class EmbeddingRunManifest:
    """The manifest of one embedding run.

    Every field of FR-011 is here, and every field that does not exist
    carries the `unknown` value.
    """

    embedding_run_id: str
    model_id: str
    revision: str
    source_uri: str
    weights_digest: str
    preprocessing_fingerprint: str
    preprocessing_components: Mapping[str, Any]
    snapshot_id: str
    asset_sha256: Tuple[str, ...]
    count: int
    dimension: int
    dtype: str
    vectors_file_digest: str
    device: str
    runtime_versions: Mapping[str, str]
    created_at: str
    latency: Mapping[str, Any]
    peak_memory_bytes: Any
    license: str
    calibration_status: str
    schema_version: int = MANIFEST_SCHEMA_VERSION
    artifact_digest: str = ""

    def to_dict(self, include_digest: bool = True) -> Dict[str, Any]:
        """The manifest as the JSON mapping the contract names.

        The names are the ones of the wire contract, and the artifact
        digest is the last field: it is the digest of every other field.
        """
        payload: Dict[str, Any] = {
            "schemaVersion": self.schema_version,
            "embeddingRunId": self.embedding_run_id,
            "modelId": self.model_id,
            "revision": self.revision,
            "sourceUri": self.source_uri,
            "weightsDigest": self.weights_digest,
            "preprocessingFingerprint": self.preprocessing_fingerprint,
            "preprocessingComponents": dict(self.preprocessing_components),
            "snapshotId": self.snapshot_id,
            "assetSha256": list(self.asset_sha256),
            "count": self.count,
            "dimension": self.dimension,
            "dtype": self.dtype,
            "vectorsFileDigest": self.vectors_file_digest,
            "device": self.device,
            "runtimeVersions": dict(self.runtime_versions),
            "createdAt": self.created_at,
            "latency": dict(self.latency),
            "peakMemoryBytes": self.peak_memory_bytes,
            "license": self.license,
            "calibrationStatus": self.calibration_status,
        }
        if include_digest:
            payload["artifactDigest"] = self.artifact_digest
        return payload

    def digest(self) -> str:
        """The content address of the artifact.

        The address covers the CONTENT of the artifact: the model, the
        revision, the preprocessing, the snapshot, the assets, the shape
        and the digest of the vectors. The run id, the timestamp, the
        latency, the peak memory, the runtime versions and the device
        describe the run and not the content, so two runs of the same
        content share the address.
        """
        payload = self.to_dict(include_digest=False)
        content = {field: payload[field] for field in CONTENT_FIELDS}
        canonical = canonical_json(content)
        return hashlib.sha256(canonical.encode("utf8")).hexdigest()

    def with_digest(self) -> "EmbeddingRunManifest":
        """The manifest with its own digest filled in."""
        return EmbeddingRunManifest(
            **{**self.__dict__, "artifact_digest": self.digest()}
        )


@dataclass(frozen=True)
class EmbeddingArtifact:
    """The artifact of one embedding run, on disk."""

    directory: Path
    manifest_path: Path
    vectors_path: Path
    manifest: EmbeddingRunManifest

    @property
    def artifact_digest(self) -> str:
        """The content address of the artifact."""
        return self.manifest.artifact_digest


def artifact_directory(root: Path, run_id: str, kind: str = ARTIFACT_KIND) -> Path:
    """The directory an artifact lives in.

    The layout is the pack's: `artifacts/<kind>/<run-id>/`
    (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:33`).
    """
    return Path(root) / "artifacts" / kind / run_id


def _write_atomic(path: Path, payload: bytes) -> None:
    """Write the bytes into the file, atomically."""
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".artifact-")
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(path))
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def write_embedding_artifact(
    root: Path,
    manifest: EmbeddingRunManifest,
    vectors: Sequence[Sequence[float]],
) -> EmbeddingArtifact:
    """Write the vectors and the manifest of one run.

    The vectors are written as float32 bytes, in the order of the images
    that produced them, and the manifest is written beside them with the
    digest of the vectors file and its own digest.

    @raises ValueError when the vectors do not match the manifest.
    """
    if len(vectors) != manifest.count:
        raise ValueError(
            "the manifest counts "
            + str(manifest.count)
            + " vectors and the run produced "
            + str(len(vectors))
        )
    for vector in vectors:
        if len(vector) != manifest.dimension:
            raise ValueError(
                "the manifest declares a dimension of "
                + str(manifest.dimension)
                + " and a vector carries "
                + str(len(vector))
            )
    import array

    packed = array.array("f", (value for vector in vectors for value in vector))
    if packed.itemsize != 4:  # pragma: no cover - every platform we ship on
        raise ValueError("the float of this platform is not 32 bits")
    payload = packed.tobytes()
    vectors_digest = hashlib.sha256(payload).hexdigest()

    directory = artifact_directory(root, manifest.embedding_run_id)
    directory.mkdir(parents=True, exist_ok=True)
    vectors_path = directory / VECTORS_FILE_NAME
    _write_atomic(vectors_path, payload)

    filled = EmbeddingRunManifest(
        **{
            **manifest.__dict__,
            "vectors_file_digest": vectors_digest,
        }
    ).with_digest()
    manifest_path = directory / MANIFEST_FILE_NAME
    _write_atomic(
        manifest_path,
        json.dumps(filled.to_dict(), sort_keys=True, indent=2).encode("utf8"),
    )
    return EmbeddingArtifact(
        directory=directory,
        manifest_path=manifest_path,
        vectors_path=vectors_path,
        manifest=filled,
    )


def read_embedding_artifact(directory: Path) -> EmbeddingArtifact:
    """Read the artifact of one run back.

    @raises ValueError when the manifest is not one this package wrote.
    """
    manifest_path = Path(directory) / MANIFEST_FILE_NAME
    vectors_path = Path(directory) / VECTORS_FILE_NAME
    if not manifest_path.is_file() or not vectors_path.is_file():
        raise ValueError(
            "the directory '" + str(directory) + "' does not hold an embedding artifact"
        )
    payload = json.loads(manifest_path.read_text(encoding="utf8"))
    manifest = manifest_from_dict(payload)
    actual = hashlib.sha256(vectors_path.read_bytes()).hexdigest()
    if actual != manifest.vectors_file_digest:
        raise ValueError(
            "the vectors file of '"
            + str(directory)
            + "' carries the digest "
            + actual
            + " and the manifest names "
            + manifest.vectors_file_digest
        )
    if manifest.artifact_digest and manifest.artifact_digest != manifest.digest():
        raise ValueError(
            "the manifest of '"
            + str(directory)
            + "' carries the artifact digest "
            + manifest.artifact_digest
            + " and its own content digests to "
            + manifest.digest()
        )
    return EmbeddingArtifact(
        directory=Path(directory),
        manifest_path=manifest_path,
        vectors_path=vectors_path,
        manifest=manifest,
    )


def manifest_from_dict(payload: Mapping[str, Any]) -> EmbeddingRunManifest:
    """Build a manifest from the JSON mapping.

    @raises ValueError when a field is missing or of the wrong type.
    """
    required = (
        "embeddingRunId",
        "modelId",
        "revision",
        "sourceUri",
        "weightsDigest",
        "preprocessingFingerprint",
        "preprocessingComponents",
        "snapshotId",
        "assetSha256",
        "count",
        "dimension",
        "dtype",
        "vectorsFileDigest",
        "device",
        "runtimeVersions",
        "createdAt",
        "latency",
        "peakMemoryBytes",
        "license",
        "calibrationStatus",
    )
    missing = [field for field in required if field not in payload]
    if missing:
        raise ValueError(
            "the manifest carries no " + ", ".join(missing)
        )
    return EmbeddingRunManifest(
        schema_version=int(payload.get("schemaVersion", MANIFEST_SCHEMA_VERSION)),
        embedding_run_id=str(payload["embeddingRunId"]),
        model_id=str(payload["modelId"]),
        revision=str(payload["revision"]),
        source_uri=str(payload["sourceUri"]),
        weights_digest=str(payload["weightsDigest"]),
        preprocessing_fingerprint=str(payload["preprocessingFingerprint"]),
        preprocessing_components=dict(payload["preprocessingComponents"]),
        snapshot_id=str(payload["snapshotId"]),
        asset_sha256=tuple(str(item) for item in payload["assetSha256"]),
        count=int(payload["count"]),
        dimension=int(payload["dimension"]),
        dtype=str(payload["dtype"]),
        vectors_file_digest=str(payload["vectorsFileDigest"]),
        device=str(payload["device"]),
        runtime_versions=dict(payload["runtimeVersions"]),
        created_at=str(payload["createdAt"]),
        latency=dict(payload["latency"]),
        peak_memory_bytes=payload["peakMemoryBytes"],
        license=str(payload["license"]),
        calibration_status=str(payload["calibrationStatus"]),
        artifact_digest=str(payload.get("artifactDigest", "")),
    )


def now_iso() -> str:
    """The timestamp of a run, in UTC and in the ISO 8601 form."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def peak_memory_bytes() -> Any:
    """The peak resident memory of this process, in bytes.

    The unit of `ru_maxrss` is the one of the platform: kilobytes on
    Linux, bytes on macOS. A platform that cannot answer records
    `unknown`, never `0`.
    """
    try:
        import resource
        import sys

        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except Exception:  # pragma: no cover - a platform without the resource module
        return UNKNOWN
    if usage <= 0:  # pragma: no cover - a platform that cannot answer
        return UNKNOWN
    if sys.platform == "darwin":
        return int(usage)
    return int(usage) * 1024


def optional_str(value: Optional[str]) -> str:
    """The value, or `unknown` when it does not exist."""
    return value if value else UNKNOWN
