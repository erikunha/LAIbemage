"""The one encoder adapter of this ticket: SigLIP2, on the CPU.

The adapter builds the model from a LOCAL directory: the weights the
loader verified and the configuration of the pinned revision. Nothing is
fetched here, and no remote code is ever executed: `trust_remote_code`
is False, so a repository that ships custom code is refused by the
library instead of being run.

The pixels are the ones the canonical preprocessing produced, so the
fingerprint of the run describes the work that was really done.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, Sequence

from ..errors import MissingExtraError
from ..io.preprocess import PreprocessedImage
from ..registry.record import ModelRecord
from ..runtime.device import DevicePlan
from .base import DTYPE, EncoderOutput

#: The extra the adapter needs, and the command that provides it.
REQUIRED_EXTRA = "vision"

#: The install command that provides the extra.
INSTALL_COMMAND = "pip install visionlens[vision]"


class Siglip2Encoder:
    """The SigLIP2 adapter, behind the Encoder protocol.

    The model is loaded on the first embedding, so an adapter that is
    built and never used costs nothing. The heavy imports are inside the
    loader, so the base install never imports torch.
    """

    def __init__(
        self,
        record: ModelRecord,
        model_dir: Path,
        device: Optional[DevicePlan] = None,
    ) -> None:
        self.model_id = record.model_id
        self.revision = record.revision
        self.dimension = record.output_dimension
        self.dtype = DTYPE
        self._record = record
        self._model_dir = Path(model_dir)
        self._device = device
        self._model: Any = None

    @property
    def device(self) -> str:
        """The device the encoder runs on."""
        if self._device is None:
            return "cpu"
        return self._device.device

    def _load(self) -> Any:
        """Build the model from the local directory.

        @raises MissingExtraError when the heavy stack is not installed.
        """
        if self._model is not None:
            return self._model
        try:
            import torch
            from transformers import AutoModel
        except ImportError as exc:
            raise MissingExtraError(
                "the SigLIP2 adapter needs the '"
                + REQUIRED_EXTRA
                + "' extra, which this environment does not have: "
                + INSTALL_COMMAND
            ) from exc
        model = AutoModel.from_pretrained(
            str(self._model_dir),
            local_files_only=True,
            trust_remote_code=False,
        )
        model.eval()
        model.to(self.device)
        self._model = model
        self._torch = torch
        return model

    def embed(self, images: Sequence[PreprocessedImage]) -> EncoderOutput:
        """Embed the preprocessed images, in the order they were given.

        @raises MissingExtraError when the heavy stack is not installed.
        @raises ValueError when the images do not share one shape.
        """
        if not images:
            raise ValueError("there is no image to embed")
        model = self._load()
        torch = self._torch
        shapes = {image.shape for image in images}
        if len(shapes) != 1:
            raise ValueError(
                "the images of one run must share one preprocessing shape, and they "
                "carry " + str(len(shapes)) + " shapes"
            )
        batch = torch.tensor(
            [list(image.values) for image in images],
            dtype=torch.float32,
        ).reshape(len(images), *next(iter(shapes)))
        batch = batch.to(self.device)
        with torch.inference_mode():
            features = model.get_image_features(pixel_values=batch)
        vectors = tuple(
            tuple(float(value) for value in row) for row in features
        )
        return EncoderOutput(vectors=vectors, dimension=self.dimension, dtype=self.dtype)
