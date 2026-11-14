"""The batch scheduler: how many images go into one model call.

A batch that exhausts the memory budget is retried with fewer images,
and the back off is an EVENT and not a silent change: the run records
the old batch size and the new one, so a run that was admitted in
smaller pieces says so (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:63`).

The number of attempts is bounded. A batch that never fits is a failure
with its reason, not an endless loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

#: The default number of images in one model call.
DEFAULT_MAX_BATCH_SIZE = 8

#: The smallest batch the scheduler ever builds. A batch of one image
#: that does not fit does not fit.
DEFAULT_MIN_BATCH_SIZE = 1

#: The number of times a batch may be reduced before the run gives up.
DEFAULT_MAX_ATTEMPTS = 3


@dataclass(frozen=True)
class ResourceFallback:
    """One resource fallback: the batch got smaller, and here is why."""

    old_batch_size: int
    new_batch_size: int
    reason: str


@dataclass(frozen=True)
class BatchPlan:
    """The batches of one run, and the fallbacks that shaped them."""

    batches: Tuple[Tuple[int, ...], ...]
    fallbacks: Tuple[ResourceFallback, ...] = ()


class BatchScheduler:
    """Group images into batches, and back off when the memory runs out.

    The scheduler holds the limits of the run: the largest batch, the
    smallest batch that is still worth trying, the number of attempts
    and, when the caller knows it, the memory budget of the run.
    """

    def __init__(
        self,
        max_batch_size: int = DEFAULT_MAX_BATCH_SIZE,
        min_batch_size: int = DEFAULT_MIN_BATCH_SIZE,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        memory_budget_bytes: Optional[int] = None,
    ) -> None:
        if max_batch_size < 1:
            raise ValueError("the largest batch must hold at least one image")
        if min_batch_size < 1:
            raise ValueError("the smallest batch must hold at least one image")
        if min_batch_size > max_batch_size:
            raise ValueError("the smallest batch may not be larger than the largest")
        if max_attempts < 1:
            raise ValueError("a run must be allowed at least one attempt")
        self.max_batch_size = max_batch_size
        self.min_batch_size = min_batch_size
        self.max_attempts = max_attempts
        self.memory_budget_bytes = memory_budget_bytes

    def batch_size_for(self, bytes_per_image: int = 0) -> int:
        """The size of one batch, given what one image costs.

        The memory budget decides when it is smaller than the largest
        batch: an image that does not fit in the budget halves the
        batch, and the batch is never smaller than the smallest one.
        """
        size = self.max_batch_size
        if self.memory_budget_bytes is not None and bytes_per_image > 0:
            affordable = self.memory_budget_bytes // bytes_per_image
            size = min(size, max(self.min_batch_size, int(affordable)))
        return max(self.min_batch_size, size)

    def plan(self, count: int, bytes_per_image: int = 0) -> BatchPlan:
        """The batches of a run over `count` images."""
        if count < 0:
            raise ValueError("the number of images may not be negative")
        size = self.batch_size_for(bytes_per_image)
        batches = tuple(
            tuple(range(start, min(start + size, count)))
            for start in range(0, count, size)
        )
        return BatchPlan(batches=batches)

    def next_batch_size(self, current: int, attempts: int) -> Optional[int]:
        """The size of the next attempt, or None when there is none.

        The size is halved, never below the smallest batch, and the
        number of attempts is bounded: a batch that never fits is a
        failure with its reason.
        """
        if attempts >= self.max_attempts:
            return None
        if current <= self.min_batch_size:
            return None
        return max(self.min_batch_size, current // 2)

    def fallback(self, old_batch_size: int, new_batch_size: int, reason: str) -> ResourceFallback:
        """The event that records one back off."""
        return ResourceFallback(
            old_batch_size=old_batch_size,
            new_batch_size=new_batch_size,
            reason=reason,
        )
