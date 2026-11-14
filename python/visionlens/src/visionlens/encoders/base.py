"""The Encoder protocol: what an adapter has to offer.

The protocol is the seam of this ticket: the runtime embeds images
through an encoder and never knows which model produced the vectors. An
adapter declares the model it is, the dimension it produces and the
dtype of its values, and the runtime records all three.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence, Tuple, runtime_checkable

from ..io.preprocess import PreprocessedImage

#: The dtype every embed result reports.
DTYPE = "float32"


@dataclass(frozen=True)
class EncoderOutput:
    """What an encoder returns: one vector per image, and its shape.

    The vectors are the values the model produced, in the order of the
    images that were handed in.
    """

    vectors: Tuple[Tuple[float, ...], ...]
    dimension: int
    dtype: str = DTYPE

    @property
    def count(self) -> int:
        """How many vectors the output carries."""
        return len(self.vectors)

    @property
    def shape(self) -> Tuple[int, int]:
        """The shape of the output: the count and the dimension."""
        return (self.count, self.dimension)


@runtime_checkable
class Encoder(Protocol):
    """What an encoder adapter has to offer.

    An adapter is built once and embedded many times. The model id, the
    revision and the dimension are the identity of the encoder, and they
    are what the run records.
    """

    model_id: str
    revision: str
    dimension: int
    dtype: str

    def embed(self, images: Sequence[PreprocessedImage]) -> EncoderOutput:
        """Embed the preprocessed images, in the order they were given."""
        ...
