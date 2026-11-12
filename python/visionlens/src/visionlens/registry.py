"""Model registry: model ids resolve to a ModelSpec or an explicit refusal.

The record shape follows the model capability registry design in
docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md: an exact revision (the
floating tag "latest" is refused), the output dimension, the supported
devices, the license and the tasks. The registry never fetches anything;
resolving a model is a pure lookup.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Tuple


class UnknownModelError(Exception):
    """Raised when a model id is not in the registry."""

    def __init__(self, model_id: str, known: Tuple[str, ...]) -> None:
        message = (
            "model '"
            + model_id
            + "' is not in the registry; known models: "
            + ", ".join(known)
        )
        super().__init__(message)
        self.model_id = model_id
        self.known_models = known


@dataclass(frozen=True)
class ModelSpec:
    """A resolved model record. Everything the simulated encoder derives from."""

    model_id: str
    revision: str
    dimension: int
    device_support: Tuple[str, ...] = ("cpu",)
    license: str = "apache-2.0"
    tasks: Tuple[str, ...] = ("image-embedding",)
    required_extra: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.model_id, str) or not self.model_id:
            raise ValueError("model_id must be a non-empty string")
        if not isinstance(self.revision, str) or not self.revision:
            raise ValueError("model '" + self.model_id + "' must pin a non-empty revision")
        if self.revision == "latest":
            # A floating revision can never back a saved run, so the registry
            # refuses it at construction time.
            raise ValueError(
                "model '" + self.model_id + "' refuses the floating revision 'latest'"
            )
        if not isinstance(self.dimension, int) or self.dimension < 1:
            raise ValueError("model '" + self.model_id + "' must declare dimension >= 1")
        if not self.device_support or any(not d for d in self.device_support):
            raise ValueError("model '" + self.model_id + "' must list at least one device")


#: The frozen default registry of the simulated runtime.
DEFAULT_MODELS: Tuple[ModelSpec, ...] = (
    ModelSpec(
        model_id="siglip2-base",
        revision="r2026-03-01",
        dimension=768,
        device_support=("cpu",),
        license="apache-2.0",
        tasks=("image-embedding", "zero-shot-image-classification"),
    ),
    ModelSpec(
        model_id="siglip2-large",
        revision="r2026-03-01",
        dimension=1152,
        device_support=("cpu",),
        license="apache-2.0",
        tasks=("image-embedding",),
        required_extra="vision",
    ),
    ModelSpec(
        model_id="clip-vit-b32",
        revision="r2026-01-15",
        dimension=512,
        device_support=("cpu",),
        license="apache-2.0",
        tasks=("image-embedding", "zero-shot-image-classification"),
    ),
    ModelSpec(
        model_id="dinov2-small",
        revision="r2026-02-20",
        dimension=384,
        device_support=("cpu", "mps"),
        license="apache-2.0",
        tasks=("image-embedding",),
    ),
)


class ModelRegistry:
    """Resolves model ids to ModelSpec records with explicit refusals."""

    def __init__(self, models: Mapping[str, ModelSpec] | None = None) -> None:
        if models is None:
            models = {spec.model_id: spec for spec in DEFAULT_MODELS}
        self._models: dict[str, ModelSpec] = dict(models)

    @classmethod
    def default(cls) -> "ModelRegistry":
        """Return the frozen default registry."""
        return cls()

    def resolve(self, model_id: str) -> ModelSpec:
        """Resolve a model id, raising UnknownModelError for anything else."""
        try:
            return self._models[model_id]
        except KeyError:
            raise UnknownModelError(model_id, self.model_ids()) from None

    def model_ids(self) -> Tuple[str, ...]:
        """Return the known model ids in sorted order."""
        return tuple(sorted(self._models))

    def __contains__(self, model_id: object) -> bool:
        return model_id in self._models

    def __len__(self) -> int:
        return len(self._models)
