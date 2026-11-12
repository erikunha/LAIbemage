"""Typed error codes for the frozen worker wire protocol.

The vocabulary, with the retryable flag of every code, is frozen in the wire
contract; the tracked statements live in
docs/vnext/contracts/proposed/worker-event.v1.schema.json. This module never
invents a code and never flips a retryable flag.

Worker-side mapping decisions (the frozen table names the cause, the worker
picks the code):

- PROTOCOL_MISMATCH: any frame whose protocol field is not
  visionlens.worker.v1.
- UNSUPPORTED_PROTOCOL: a hello or a request whose version major differs from
  the worker's, an unsupported device, or any frame arriving before the host
  hello completes the handshake.
- MALFORMED_FRAME: an unparsable line, a wrong shape, an unknown or missing
  field, an oversized frame, or params naming an unknown model or recipe.
- MISSING_EXTRA: a registry model whose required extra is not installed.
- UNSUPPORTED_OPERATION: an operation code outside the advertised set.
- CANCELLED: the host asked to stop an in-flight request.
- DEADLINE_EXCEEDED: budget.maxSeconds elapsed before completion.
- BUDGET_EXCEEDED: the simulated token cost exceeds budget.maxTokens.
- WORKER_CRASHED: an unexpected internal failure; the worker keeps serving.
- PROVIDER_UNAVAILABLE: reserved for transient provider IO; the simulated
  path never emits it.
"""

from __future__ import annotations

import enum


class ErrorCode(str, enum.Enum):
    """The frozen error vocabulary of the worker protocol."""

    UNSUPPORTED_PROTOCOL = "UNSUPPORTED_PROTOCOL"
    MISSING_EXTRA = "MISSING_EXTRA"
    MALFORMED_FRAME = "MALFORMED_FRAME"
    PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH"
    UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION"
    CANCELLED = "CANCELLED"
    DEADLINE_EXCEEDED = "DEADLINE_EXCEEDED"
    BUDGET_EXCEEDED = "BUDGET_EXCEEDED"
    WORKER_CRASHED = "WORKER_CRASHED"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"


_RETRYABLE: dict[ErrorCode, bool] = {
    ErrorCode.UNSUPPORTED_PROTOCOL: False,
    ErrorCode.MISSING_EXTRA: False,
    ErrorCode.MALFORMED_FRAME: False,
    ErrorCode.PROTOCOL_MISMATCH: False,
    ErrorCode.UNSUPPORTED_OPERATION: False,
    ErrorCode.CANCELLED: False,
    ErrorCode.DEADLINE_EXCEEDED: False,
    ErrorCode.BUDGET_EXCEEDED: False,
    ErrorCode.WORKER_CRASHED: True,
    ErrorCode.PROVIDER_UNAVAILABLE: True,
}


def is_retryable(code: ErrorCode) -> bool:
    """Return the frozen retryable flag of an error code."""
    return _RETRYABLE[code]


class WorkerError(Exception):
    """A typed protocol failure carrying one of the frozen error codes."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def retryable(self) -> bool:
        """Return the frozen retryable flag of this error's code."""
        return is_retryable(self.code)
