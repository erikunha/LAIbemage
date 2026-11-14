"""The `vision.embed` operation: images in, vectors on disk out.

The operation decodes the images, applies the canonical preprocessing,
embeds them in batches and writes the artifact. The result frame
carries the run id, the dimension, the dtype, the count, the digest of
the artifact and the errors, and it never carries the vectors: the
vectors are in the artifact, in a binary file, beside the manifest that
describes them (`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:14`).

An image that cannot be decoded is an error sample and not a failed
run: the other images still embed, and the error names the file.

The Python side writes no domain row. It emits a versioned manifest for
the TypeScript side to validate and commit
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:46`).
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple

from ..encoders.base import Encoder, EncoderOutput
from ..errors import LibraryError
from ..io.decode import DecodeService
from ..io.preprocess import PreprocessingSpec
from ..registry.record import ModelRecord
from ..runtime.device import DevicePlan
from .artifact import (
    UNKNOWN,
    EmbeddingArtifact,
    EmbeddingRunManifest,
    latency_percentiles,
    now_iso,
    peak_memory_bytes,
    write_embedding_artifact,
)
from .batching import BatchScheduler, ResourceFallback


@dataclass(frozen=True)
class EmbedAsset:
    """One image of a run: the asset id and where its bytes live."""

    asset_id: str
    path: Path


@dataclass(frozen=True)
class EmbedError:
    """One image that could not be embedded, and why."""

    asset_id: str
    path: str
    code: str
    message: str


@dataclass(frozen=True)
class EmbedRequest:
    """One request to embed a set of images."""

    snapshot_id: str
    assets: Tuple[EmbedAsset, ...]


@dataclass(frozen=True)
class EmbedResult:
    """What the operation returns.

    The vectors are NOT here: they are in the artifact, and this result
    carries the digest that proves which bytes they are.
    """

    run_id: str
    model_id: str
    revision: str
    dimension: int
    dtype: str
    count: int
    artifact_sha256: str
    artifact_path: Path
    device: str
    errors: Tuple[EmbedError, ...] = ()
    fallbacks: Tuple[ResourceFallback, ...] = ()


def runtime_versions() -> Dict[str, str]:
    """The versions of the runtime that produced the vectors.

    A package that is not installed is not named: the manifest says what
    was there, not what could have been.
    """
    import importlib.metadata as metadata

    versions: Dict[str, str] = {}
    for name in ("torch", "transformers", "safetensors", "pillow"):
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            continue
    return versions


class VisionEmbedder:
    """The CPU embedding run.

    The embedder owns the pipeline of the ticket: decode, preprocess,
    batch, embed, write the artifact. Every part it uses is injected,
    so a run is reproducible and a test never reaches the network.
    """

    def __init__(
        self,
        record: ModelRecord,
        encoder: Encoder,
        spec: PreprocessingSpec,
        decoder: DecodeService,
        device: DevicePlan,
        artifact_root: Path,
        scheduler: Optional[BatchScheduler] = None,
        snapshot_id: str = "snapshot-unknown",
    ) -> None:
        self.record = record
        self.encoder = encoder
        self.spec = spec
        self.decoder = decoder
        self.device = device
        self.artifact_root = Path(artifact_root)
        self.scheduler = scheduler or BatchScheduler()
        self.snapshot_id = snapshot_id

    def embed(self, request: EmbedRequest) -> EmbedResult:
        """Embed the images of the request and write the artifact.

        @raises LibraryError when the run may not be served at all.
        """
        run_id = "embed-" + uuid.uuid4().hex
        errors: list[EmbedError] = []
        fallbacks: list[ResourceFallback] = []
        latencies: list[float] = []
        prepared: list[Tuple[EmbedAsset, Any]] = []

        for asset in request.assets:
            try:
                decoded = self.decoder.decode(asset.path)
                prepared.append((asset, self.spec.apply(decoded.image)))
            except LibraryError as exc:
                errors.append(
                    EmbedError(
                        asset_id=asset.asset_id,
                        path=str(asset.path),
                        code=exc.code.value,
                        message=exc.message,
                    )
                )

        vectors: list[Tuple[float, ...]] = []
        if prepared:
            output = self._embed_in_batches(prepared, latencies, fallbacks)
            vectors = list(output.vectors)
        asset_digests = [self._digest_of(asset) for asset, _ in prepared]

        manifest = EmbeddingRunManifest(
            embedding_run_id=run_id,
            model_id=self.record.model_id,
            revision=self.record.revision,
            source_uri=self.record.source_uri,
            weights_digest=self.record.source_digest,
            preprocessing_fingerprint=self.spec.fingerprint(),
            preprocessing_components=self.spec.components(),
            snapshot_id=request.snapshot_id,
            asset_sha256=tuple(asset_digests),
            count=len(vectors),
            dimension=self.encoder.dimension,
            dtype=self.encoder.dtype,
            vectors_file_digest="",
            device=self.device.device,
            runtime_versions=runtime_versions(),
            created_at=now_iso(),
            latency=latency_percentiles(latencies),
            peak_memory_bytes=peak_memory_bytes(),
            license=self.record.license,
            calibration_status=self.record.calibration_status,
        )
        artifact = write_embedding_artifact(self.artifact_root, manifest, vectors)
        return EmbedResult(
            run_id=run_id,
            model_id=self.record.model_id,
            revision=self.record.revision,
            dimension=self.encoder.dimension,
            dtype=self.encoder.dtype,
            count=len(vectors),
            artifact_sha256=artifact.artifact_digest,
            artifact_path=artifact.directory,
            device=self.device.device,
            errors=tuple(errors),
            fallbacks=tuple(fallbacks),
        )

    def _digest_of(self, asset: EmbedAsset) -> str:
        """The digest of the bytes of an asset."""
        from ..hashing import sha256_of_file

        return sha256_of_file(asset.path)

    def _embed_in_batches(
        self,
        prepared: Sequence[Tuple[EmbedAsset, Any]],
        latencies: list[float],
        fallbacks: list[ResourceFallback],
    ) -> EncoderOutput:
        """Embed the images, backing off when the memory runs out.

        @raises LibraryError when no batch of the images fits.
        """
        count = len(prepared)
        batch_size = self.scheduler.batch_size_for()
        attempts = 0
        vectors: list[Tuple[float, ...]] = []
        start = 0
        while start < count:
            size = min(batch_size, count - start)
            started = time.perf_counter()
            try:
                output = self.encoder.embed(
                    [image for _, image in prepared[start : start + size]]
                )
            except Exception as exc:
                if not _is_memory_error(exc):
                    raise self._model_error(exc) from exc
                reduced = self.scheduler.next_batch_size(size, attempts)
                if reduced is None:
                    raise self._resource_error(exc, size) from exc
                attempts += 1
                fallbacks.append(
                    self.scheduler.fallback(size, reduced, str(exc))
                )
                batch_size = reduced
                continue
            elapsed = time.perf_counter() - started
            latencies.extend([elapsed * 1000.0 / size] * size)
            vectors.extend(output.vectors)
            start += size
        return EncoderOutput(
            vectors=tuple(vectors),
            dimension=self.encoder.dimension,
            dtype=self.encoder.dtype,
        )

    def _resource_error(self, exc: Exception, size: int) -> LibraryError:
        """The typed error of a run that never fit in the memory budget."""
        from ..errors import ResourceExhaustedError

        return ResourceExhaustedError(
            "the batch of "
            + str(size)
            + " images did not fit in the memory budget, and the number of "
            "attempts is bounded: "
            + str(exc)
        )

    def _model_error(self, exc: Exception) -> LibraryError:
        """The typed error of a model that refused the batch."""
        from ..errors import ModelRunFailedError

        return ModelRunFailedError("the model refused the batch: " + str(exc))


def _is_memory_error(exc: Exception) -> bool:
    """Whether an exception is the memory of the machine running out.

    Only a memory exhaustion is retried with a smaller batch: any other
    failure is a failure, and retrying it would hide it.
    """
    name = exc.__class__.__name__
    if "OutOfMemory" in name:
        return True
    message = str(exc).lower()
    return "out of memory" in message or "not enough memory" in message
