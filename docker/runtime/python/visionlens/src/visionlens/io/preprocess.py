"""The canonical preprocessing specification, and its fingerprint.

Two runs with different preprocessing cannot be compared as equivalent
(`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:23`), so the
preprocessing is a RECORD and not a habit: it has a shape, it has a
fingerprint, and the fingerprint is the one the registry record carries.

The specification is derived from the processor config of the pinned
revision, which is the same config the fingerprint of the record was
computed from. A spec that is not the record's spec is a run that may
not be compared with the record's runs, and the fingerprint is how that
is said out loud.

The pixels are produced by the specification itself, so the fingerprint
describes the work that was really done and not a description of it.
"""

from __future__ import annotations

import array
import hashlib
import sys
from dataclasses import dataclass
from typing import Any, Mapping, Tuple

from ..encoder import components_from_preprocessor_config, fingerprint_of_components

#: The resample names the specification understands, and the Pillow code
#: each one names.
RESAMPLE_CODES: Mapping[str, int] = {
    "nearest": 0,
    "lanczos": 1,
    "bilinear": 2,
    "bicubic": 3,
    "box": 4,
    "hamming": 5,
}


@dataclass(frozen=True)
class PreprocessedImage:
    """One preprocessed image: the values, the shape and the spec."""

    spec: "PreprocessingSpec"
    width: int
    height: int
    channels: int
    values: Tuple[float, ...]

    @property
    def shape(self) -> Tuple[int, int, int]:
        """The shape of the values: channels first, then height, then width."""
        return (self.channels, self.height, self.width)

    @property
    def layout(self) -> str:
        """The layout of the values: the channels come first."""
        return "CHW"

    def digest(self) -> str:
        """The sha256 of the values as float32 bytes.

        The digest is of the bytes the encoder consumes, so two runs of
        the same image and the same spec produce the same digest.
        """
        packed = array.array("f", self.values)
        if sys.byteorder != "little":
            packed.byteswap()
        return hashlib.sha256(packed.tobytes()).hexdigest()


@dataclass(frozen=True)
class PreprocessingSpec:
    """The canonical preprocessing of one model.

    The fields are the ones the pipeline names: the input image size,
    the resize, the rescale and the normalization. The fingerprint is
    derived from them, never written by hand.
    """

    height: int
    width: int
    interpolation: str
    rescale_factor: float
    mean: Tuple[float, ...]
    std: Tuple[float, ...]

    def __post_init__(self) -> None:
        if self.height <= 0 or self.width <= 0:
            raise ValueError("the input image size must be positive")
        if self.interpolation not in RESAMPLE_CODES:
            raise ValueError(
                "the interpolation '"
                + self.interpolation
                + "' is not one the preprocessor knows ("
                + ", ".join(sorted(RESAMPLE_CODES))
                + ")"
            )
        if self.rescale_factor <= 0:
            raise ValueError("the rescale factor must be positive")
        if not self.mean or not self.std:
            raise ValueError("the normalization must carry a mean and a standard deviation")
        if len(self.mean) != len(self.std):
            raise ValueError("the mean and the standard deviation must have the same length")
        if any(value == 0 for value in self.std):
            raise ValueError("a standard deviation of zero divides by zero")

    @classmethod
    def from_preprocessor_config(cls, config: Mapping[str, object]) -> "PreprocessingSpec":
        """The specification of a processor config.

        The config is the one a model repository ships at its pinned
        revision, and the components are read with the repository's own
        reader, so the fingerprint of the specification is the
        fingerprint the record carries.

        @raises ValueError when the config cannot describe a preprocessing.
        """
        components = components_from_preprocessor_config(config)
        resize = components["resize"]
        assert isinstance(resize, Mapping)
        normalize = components["normalize"]
        assert isinstance(normalize, Mapping)
        rescale = components["rescale"]
        assert isinstance(rescale, Mapping)
        mean = normalize["mean"]
        std = normalize["std"]
        assert isinstance(mean, list) and isinstance(std, list)
        factor = rescale["factor"]
        assert isinstance(factor, float)
        interpolation = components["interpolation"]
        assert isinstance(interpolation, str)
        return cls(
            height=int(resize["height"]),
            width=int(resize["width"]),
            interpolation=interpolation,
            rescale_factor=factor,
            mean=tuple(float(value) for value in mean),
            std=tuple(float(value) for value in std),
        )

    def components(self) -> dict[str, object]:
        """The canonical components of the specification.

        The components are what the fingerprint is computed from, in the
        shape the repository uses for every model.
        """
        return {
            "resize": {"height": self.height, "width": self.width},
            "interpolation": self.interpolation,
            "rescale": {"factor": self.rescale_factor},
            "normalize": {
                "mean": [float(value) for value in self.mean],
                "std": [float(value) for value in self.std],
            },
        }

    def fingerprint(self) -> str:
        """The fp2 fingerprint of the specification."""
        return fingerprint_of_components(self.components())

    def matches(self, preprocessing_fingerprint: str) -> bool:
        """Whether the specification is the one a fingerprint names."""
        return self.fingerprint() == preprocessing_fingerprint

    def apply(self, image: Any) -> PreprocessedImage:
        """Apply the specification to an image.

        The pixels are produced by this specification and not by a
        description of it: the resize, the rescale and the normalization
        are the ones the fingerprint covers.

        @raises ValueError when the image cannot be read.
        """
        from PIL import Image

        if len(self.mean) != 3:
            raise ValueError("the normalization of this platform has three channels")
        resized = image.convert("RGB").resize(
            (self.width, self.height), RESAMPLE_CODES[self.interpolation]
        )
        pixels = resized.tobytes()
        channels = 3
        plane = self.width * self.height
        # The values are CHANNEL FIRST: the whole red plane, then the whole
        # green plane, then the whole blue plane. The layout is part of the
        # contract of the model, and the shape of the record says so.
        values: list[float] = []
        for channel in range(channels):
            offset = self.mean[channel]
            scale = self.std[channel]
            for index in range(plane):
                value = pixels[index * 3 + channel] * self.rescale_factor
                values.append((value - offset) / scale)
        return PreprocessedImage(
            spec=self,
            width=self.width,
            height=self.height,
            channels=channels,
            values=tuple(values),
        )


def spec_of_record(record: Any, config: Mapping[str, object]) -> PreprocessingSpec:
    """The specification of a record, and whether the record agrees with it.

    A record names the fingerprint of the preprocessing it was measured
    with. The spec built from the pinned config has to carry that
    fingerprint, or the run is not the run the record describes.

    @raises ValueError when the spec does not match the record.
    """
    spec = PreprocessingSpec.from_preprocessor_config(config)
    if not spec.matches(record.preprocessing_fingerprint):
        raise ValueError(
            "the preprocessing of the config carries the fingerprint "
            + spec.fingerprint()
            + ", and the record names "
            + record.preprocessing_fingerprint
        )
    return spec
