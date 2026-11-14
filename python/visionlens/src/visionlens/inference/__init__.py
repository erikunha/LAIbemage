"""The inference: the run, the artifact and the manifest that describes it.

The vectors of a run live on disk, in a content-addressed artifact: a
binary vectors file beside a manifest that says what produced them. The
vectors never travel inside a JSON line, and the manifest never carries
a base64 payload: the frame carries the run id, the shape and the
digest, and the bytes stay where they were written
(`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:14`).

A value that does not exist is recorded as `unknown` and never as `0`
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:24`).
"""

from __future__ import annotations

from .artifact import (
    MANIFEST_SCHEMA_VERSION,
    UNKNOWN,
    EmbeddingArtifact,
    EmbeddingRunManifest,
    artifact_directory,
    latency_percentiles,
    write_embedding_artifact,
)
from .batching import BatchScheduler, ResourceFallback
from .embedder import EmbedRequest, EmbedResult, VisionEmbedder

__all__ = [
    "MANIFEST_SCHEMA_VERSION",
    "UNKNOWN",
    "BatchScheduler",
    "EmbedRequest",
    "EmbedResult",
    "EmbeddingArtifact",
    "EmbeddingRunManifest",
    "ResourceFallback",
    "VisionEmbedder",
    "artifact_directory",
    "latency_percentiles",
    "write_embedding_artifact",
]
