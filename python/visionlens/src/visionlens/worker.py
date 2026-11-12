"""The JSONL worker: frames on stdout, logs on stderr.

The worker speaks the frozen visionlens.worker.v1 wire format. It emits its
hello frame unprompted, refuses every operation until the host hello
arrives, serves the five frozen operations in one thread per request, keeps
seq strictly increasing per requestId, honors cancel and budget.maxSeconds,
and refuses any line that is not a frame without dying.

Run it as a module: python -m visionlens.worker
"""

from __future__ import annotations

import json
import logging
import os
import select
import signal
import sys
import threading
import time
from types import FrameType
from typing import Any, BinaryIO, Callable, Mapping, Sequence

from . import protocol
from .errors import ErrorCode, WorkerError
from .operations import OPERATION_HANDLERS, OperationContext
from .registry import ModelRegistry

LOG = logging.getLogger("visionlens.worker")


class FrameTooLargeError(Exception):
    """Raised by the reader when a line exceeds the frame byte limit."""


class _GracefulExit(Exception):
    """Raised inside the main thread when SIGTERM or SIGINT arrives."""


class BoundedLineReader:
    """Read newline-terminated frames without buffering an oversized line.

    Once the accumulated bytes of a line pass the limit the reader stops
    buffering, discards the remainder of that line and raises
    FrameTooLargeError, so a giant line never lands in memory whole.

    The optional wakeup pipe exists so a signal can interrupt a blocked
    read. Signal handlers must never raise from inside foreign code (the
    logging module, for one, swallows such exceptions); with a wakeup fd
    the interpreter writes a byte to the pipe, select unblocks and the
    wake handler raises from here, inside this reader, where nothing
    swallows it.
    """

    def __init__(
        self,
        stream: BinaryIO,
        max_frame_bytes: int,
        chunk_size: int = 4096,
        *,
        wakeup_fd: int | None = None,
        wake_handler: Callable[[], None] | None = None,
    ) -> None:
        self._stream = stream
        self._chunk_size = chunk_size
        self._carry = b""
        self._max_frame_bytes = max_frame_bytes
        self._wakeup_fd = wakeup_fd
        self._wake_handler = wake_handler
        self._stream_fd: int | None = None
        if wakeup_fd is not None:
            try:
                self._stream_fd = stream.fileno()
            except (AttributeError, OSError, ValueError):
                self._stream_fd = None
            if self._stream_fd is None:
                self._wakeup_fd = None

    @property
    def max_frame_bytes(self) -> int:
        """The current frame byte limit."""
        return self._max_frame_bytes

    @max_frame_bytes.setter
    def max_frame_bytes(self, value: int) -> None:
        if value < 1:
            raise ValueError("max_frame_bytes must be a positive integer")
        self._max_frame_bytes = value

    def read_line(self) -> bytes | None:
        """Return the next line without its newline, or None at end of input."""
        buffer = bytearray()
        while True:
            if self._carry:
                newline = self._carry.find(b"\n")
                if newline >= 0:
                    line = self._carry[:newline]
                    self._carry = self._carry[newline + 1 :]
                    return self._finish(line)
                buffer += self._carry
                self._carry = b""
            else:
                chunk = self._read_chunk()
                if not chunk:
                    if buffer:
                        return self._finish(bytes(buffer))
                    return None
                newline = chunk.find(b"\n")
                if newline >= 0:
                    buffer += chunk[:newline]
                    self._carry = chunk[newline + 1 :]
                    return self._finish(bytes(buffer))
                buffer += chunk
            if len(buffer) > self._max_frame_bytes:
                self._discard_to_newline()
                raise FrameTooLargeError(
                    "line exceeds the negotiated frame limit of "
                    + str(self._max_frame_bytes)
                    + " bytes"
                )

    def _finish(self, line: bytes) -> bytes:
        if len(line) > self._max_frame_bytes:
            raise FrameTooLargeError(
                "line exceeds the negotiated frame limit of "
                + str(self._max_frame_bytes)
                + " bytes"
            )
        if line.endswith(b"\r"):
            return line[:-1]
        return line

    def _discard_to_newline(self) -> None:
        while not self._carry:
            chunk = self._read_chunk()
            if not chunk:
                return
            newline = chunk.find(b"\n")
            if newline >= 0:
                self._carry = chunk[newline + 1 :]
                return

    def _read_chunk(self) -> bytes:
        if self._wakeup_fd is not None and self._stream_fd is not None:
            assert self._wake_handler is not None
            while True:
                readable, _, _ = select.select([self._stream_fd, self._wakeup_fd], [], [])
                if self._wakeup_fd in readable:
                    self._drain_wakeup()
                    self._wake_handler()
                if self._stream_fd in readable:
                    break
        read1 = getattr(self._stream, "read1", None)
        if read1 is not None:
            return read1(self._chunk_size)
        return self._stream.read(self._chunk_size)

    def _drain_wakeup(self) -> None:
        assert self._wakeup_fd is not None
        try:
            while True:
                if not os.read(self._wakeup_fd, 4096):
                    return
        except BlockingIOError:
            return


class _RequestState:
    """Bookkeeping for one in-flight request."""

    __slots__ = ("request_id", "max_seconds", "deadline_at", "cancel_event", "finished", "thread")

    def __init__(self, request_id: str, deadline_at: float, max_seconds: int) -> None:
        self.request_id = request_id
        self.max_seconds = max_seconds
        self.deadline_at = deadline_at
        self.cancel_event = threading.Event()
        self.finished = False
        self.thread: threading.Thread | None = None


class Worker:
    """A long-lived JSONL worker over two byte streams.

    The reader stream carries host frames (stdin in production); the writer
    stream carries only frames (stdout in production). Every diagnostic goes
    to the logger, which main() wires to stderr. The streams are injectable
    so tests and the golden recorder can drive the exact same loop.
    """

    def __init__(
        self,
        *,
        reader: BinaryIO,
        writer: BinaryIO,
        registry: ModelRegistry | None = None,
        extras: Sequence[str] = (),
        logger: logging.Logger | None = None,
        wakeup_fd: int | None = None,
        wake_handler: Callable[[], None] | None = None,
        shutdown_event: threading.Event | None = None,
    ) -> None:
        self._registry = registry if registry is not None else ModelRegistry.default()
        self._installed_extras = tuple(sorted(set(extras)))
        self._reader = BoundedLineReader(
            reader,
            protocol.DEFAULT_MAX_FRAME_BYTES,
            wakeup_fd=wakeup_fd,
            wake_handler=wake_handler,
        )
        self._writer = writer
        self._lock = threading.Lock()
        self._requests: dict[str, _RequestState] = {}
        self._seq_counters: dict[str, int] = {}
        self._hello_received = False
        self._logger = logger or LOG
        self._shutdown_event = shutdown_event if shutdown_event is not None else threading.Event()

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def run(self) -> int:
        """Serve frames until end of input or a shutdown signal; return 0."""
        self._emit_hello()
        try:
            while True:
                if self._shutdown_event.is_set():
                    self._logger.info("shutdown signal received; cancelling in-flight requests")
                    self._cancel_all()
                    break
                try:
                    line = self._reader.read_line()
                except FrameTooLargeError as exc:
                    self._emit_preflight_error("", ErrorCode.MALFORMED_FRAME, str(exc))
                    continue
                if line is None:
                    self._logger.debug("end of input")
                    break
                self._logger.debug("read line of %d bytes", len(line))
                self._handle_line(line)
        except _GracefulExit:
            self._logger.info("shutdown signal received; cancelling in-flight requests")
            self._cancel_all()
        except BrokenPipeError:
            self._logger.info("stdout closed by the host; stopping")
            self._cancel_all()
        self._join_pending()
        return 0

    # ------------------------------------------------------------------
    # Line handling
    # ------------------------------------------------------------------

    def _handle_line(self, line: bytes) -> None:
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            self._emit_preflight_error("", ErrorCode.MALFORMED_FRAME, "frame is not valid UTF-8")
            return
        if not text.strip():
            self._emit_preflight_error("", ErrorCode.MALFORMED_FRAME, "empty line is not a frame")
            return
        try:
            obj = json.loads(text)
        except ValueError:
            self._emit_preflight_error("", ErrorCode.MALFORMED_FRAME, "line is not valid JSON")
            return
        if not isinstance(obj, dict):
            self._emit_preflight_error(
                "", ErrorCode.MALFORMED_FRAME, "frame must be a JSON object"
            )
            return
        request_id = obj.get("requestId")
        recoverable = request_id if isinstance(request_id, str) and request_id else ""
        protocol_field = obj.get("protocol")
        if not isinstance(protocol_field, str):
            self._emit_preflight_error(
                recoverable, ErrorCode.MALFORMED_FRAME, "frame misses the required protocol field"
            )
            return
        if protocol_field != protocol.PROTOCOL:
            self._emit_preflight_error(
                recoverable,
                ErrorCode.PROTOCOL_MISMATCH,
                "frame protocol '"
                + protocol_field
                + "' is not spoken by this worker; expected '"
                + protocol.PROTOCOL
                + "'",
            )
            return
        kind = obj.get("kind")
        if kind is None:
            self._emit_preflight_error(
                recoverable, ErrorCode.MALFORMED_FRAME, "frame misses the required kind field"
            )
            return
        if not isinstance(kind, str) or kind not in protocol.FRAME_KINDS:
            self._emit_preflight_error(
                recoverable, ErrorCode.MALFORMED_FRAME, "unknown frame kind '" + str(kind) + "'"
            )
            return
        if kind == "hello":
            self._handle_host_hello(obj)
        elif kind == "request":
            self._handle_request(obj, recoverable)
        elif kind == "cancel":
            self._handle_cancel(obj, recoverable)
        else:
            self._emit_preflight_error(
                recoverable,
                ErrorCode.MALFORMED_FRAME,
                "frame kind '" + kind + "' is not accepted from the host",
            )

    def _handle_host_hello(self, obj: Mapping[str, object]) -> None:
        if self._hello_received:
            self._emit_preflight_error(
                "", ErrorCode.MALFORMED_FRAME, "duplicate hello after the handshake completed"
            )
            return
        try:
            hello = protocol.validate_host_hello(obj)
        except WorkerError as exc:
            self._emit_preflight_error("", exc.code, exc.message)
            return
        host_protocol_major = protocol.protocol_major(hello.protocol_version)
        if host_protocol_major != protocol.PROTOCOL_MAJOR:
            self._emit_preflight_error(
                "",
                ErrorCode.UNSUPPORTED_PROTOCOL,
                "host protocolVersion major "
                + str(host_protocol_major)
                + " is not supported; this worker speaks "
                + protocol.PROTOCOL_VERSION,
            )
            return
        host_contract_major = protocol.protocol_major(hello.contract_version)
        if host_contract_major != protocol.CONTRACT_MAJOR:
            self._emit_preflight_error(
                "",
                ErrorCode.UNSUPPORTED_PROTOCOL,
                "host contractVersion major "
                + str(host_contract_major)
                + " is not supported; this worker serves contract major "
                + str(protocol.CONTRACT_MAJOR),
            )
            return
        self._hello_received = True
        if hello.max_frame_bytes is not None:
            self._reader.max_frame_bytes = hello.max_frame_bytes
            self._logger.info(
                "frame limit negotiated to %d bytes", hello.max_frame_bytes
            )
        self._logger.info(
            "handshake complete: host protocol %s, contract %s",
            hello.protocol_version,
            hello.contract_version,
        )

    def _handle_request(self, obj: Mapping[str, object], recoverable: str) -> None:
        if not self._hello_received:
            self._emit_preflight_error(
                recoverable,
                ErrorCode.UNSUPPORTED_PROTOCOL,
                "request refused: the host hello has not been received",
            )
            return
        try:
            frame = protocol.validate_request_frame(obj)
        except WorkerError as exc:
            self._emit_preflight_error(recoverable, exc.code, exc.message)
            return
        contract_major = protocol.protocol_major(frame.contract_version)
        if contract_major != protocol.CONTRACT_MAJOR:
            self._emit_preflight_error(
                frame.request_id,
                ErrorCode.UNSUPPORTED_PROTOCOL,
                "request contractVersion major "
                + str(contract_major)
                + " is not supported; this worker serves contract major "
                + str(protocol.CONTRACT_MAJOR),
            )
            return
        if frame.operation not in OPERATION_HANDLERS:
            self._emit_preflight_error(
                frame.request_id,
                ErrorCode.UNSUPPORTED_OPERATION,
                "operation '"
                + frame.operation
                + "' is not in the advertised set: "
                + ", ".join(protocol.OPERATIONS),
            )
            return
        with self._lock:
            existing = self._requests.get(frame.request_id)
            in_flight = existing is not None and not existing.finished
        if in_flight:
            # A second request with an in-flight id is a correlation
            # violation. Answering with an error frame would break the frozen
            # rule of exactly one terminal frame per request, so the
            # duplicate is dropped and the violation is reported on stderr.
            self._logger.error(
                "requestId %s arrived again while in flight; duplicate dropped",
                frame.request_id,
            )
            return
        deadline_at = time.monotonic() + frame.budget.max_seconds
        state = _RequestState(frame.request_id, deadline_at, frame.budget.max_seconds)
        with self._lock:
            self._requests[frame.request_id] = state
        thread = threading.Thread(
            target=self._run_request,
            args=(state, frame),
            name="visionlens-" + frame.request_id,
            daemon=True,
        )
        state.thread = thread
        thread.start()
        self._logger.info(
            "request %s operation %s started", frame.request_id, frame.operation
        )

    def _handle_cancel(self, obj: Mapping[str, object], recoverable: str) -> None:
        if not self._hello_received:
            self._emit_preflight_error(
                recoverable,
                ErrorCode.UNSUPPORTED_PROTOCOL,
                "cancel refused: the host hello has not been received",
            )
            return
        try:
            request_id = protocol.validate_cancel_frame(obj)
        except WorkerError as exc:
            self._emit_preflight_error(recoverable, exc.code, exc.message)
            return
        with self._lock:
            state = self._requests.get(request_id)
            if state is not None and not state.finished:
                state.cancel_event.set()
                cancelled = True
            else:
                cancelled = False
        if cancelled:
            self._logger.info("cancellation requested for request %s", request_id)
        else:
            self._logger.info(
                "cancel for request %s recorded as a no-op: no in-flight request", request_id
            )

    # ------------------------------------------------------------------
    # Request execution
    # ------------------------------------------------------------------

    def _run_request(self, state: _RequestState, frame: protocol.RequestFrame) -> None:
        context = OperationContext(
            registry=self._registry,
            installed_extras=self._installed_extras,
            max_tokens=frame.budget.max_tokens,
            progress=lambda completed, total: self._emit_progress(state, completed, total),
            checkpoint=lambda: self._checkpoint(state),
            sleep=lambda seconds: self._sleep(state, seconds),
        )
        try:
            handler = OPERATION_HANDLERS[frame.operation]
            result = handler(frame.params, context)
        except WorkerError as exc:
            self._emit_terminal(state, error=exc)
        except Exception:
            self._logger.exception("request %s failed unexpectedly", state.request_id)
            self._emit_terminal(
                state,
                error=WorkerError(
                    ErrorCode.WORKER_CRASHED,
                    "the worker hit an unexpected internal error; see its stderr log",
                ),
            )
        else:
            self._emit_terminal(state, result=result)
        finally:
            with self._lock:
                state.finished = True
                self._requests.pop(state.request_id, None)
                # The terminal frame above was the counter's last reader, so
                # the entry is dropped here under the same lock; seq stayed
                # strictly increasing across the request's lifetime, and the
                # counter no longer grows with every terminated request.
                self._seq_counters.pop(state.request_id, None)
                self._logger.info("request %s finished", state.request_id)

    def _checkpoint(self, state: _RequestState) -> None:
        if state.cancel_event.is_set():
            raise WorkerError(ErrorCode.CANCELLED, "request cancelled by the host")
        if time.monotonic() >= state.deadline_at:
            raise WorkerError(
                ErrorCode.DEADLINE_EXCEEDED,
                "budget.maxSeconds of "
                + str(state.max_seconds)
                + " elapsed before the operation completed",
            )

    def _sleep(self, state: _RequestState, seconds: float) -> None:
        if state.cancel_event.wait(seconds):
            raise WorkerError(
                ErrorCode.CANCELLED, "request cancelled by the host during a work step"
            )

    def _cancel_all(self) -> None:
        with self._lock:
            states = [s for s in self._requests.values() if not s.finished]
        for state in states:
            state.cancel_event.set()

    def _join_pending(self) -> None:
        with self._lock:
            threads = [s.thread for s in self._requests.values() if s.thread is not None]
        for thread in threads:
            thread.join(timeout=30.0)
        with self._lock:
            stuck = [s.request_id for s in self._requests.values() if not s.finished]
        if stuck:
            self._logger.error("requests still running at shutdown: %s", ", ".join(stuck))

    # ------------------------------------------------------------------
    # Frame emission. All writers hold the lock; seq is allocated under the
    # same lock so it is strictly increasing per requestId, starting at 0.
    # ------------------------------------------------------------------

    def _next_seq(self, request_id: str) -> int:
        current = self._seq_counters.get(request_id, -1) + 1
        self._seq_counters[request_id] = current
        return current

    def _write(self, frame: Mapping[str, object]) -> None:
        self._writer.write(protocol.encode_frame(frame))
        self._writer.flush()

    def _emit_hello(self) -> None:
        capabilities = {
            "device": "cpu",
            "extras": list(self._installed_extras),
            "models": list(self._registry.model_ids()),
        }
        with self._lock:
            self._write(
                protocol.hello_frame(
                    supported_operations=protocol.OPERATIONS,
                    capabilities=capabilities,
                    max_frame_bytes=protocol.DEFAULT_MAX_FRAME_BYTES,
                )
            )

    def _emit_progress(self, state: _RequestState, completed: int, total: int) -> None:
        if completed > total:
            raise ValueError(
                "completed "
                + str(completed)
                + " exceeds total "
                + str(total)
                + " for request "
                + state.request_id
            )
        with self._lock:
            self._write(
                protocol.progress_frame(state.request_id, self._next_seq(state.request_id), completed, total)
            )

    def _emit_terminal(
        self,
        state: _RequestState,
        result: Mapping[str, object] | None = None,
        error: WorkerError | None = None,
    ) -> None:
        with self._lock:
            if result is not None and state.cancel_event.is_set():
                # The cancel raced the terminal frame; the cancellation wins
                # and no result is emitted.
                error = WorkerError(ErrorCode.CANCELLED, "request cancelled by the host")
                result = None
            seq = self._next_seq(state.request_id)
            if error is not None:
                frame = protocol.error_frame(state.request_id, seq, error.code, error.message)
            else:
                assert result is not None
                frame = protocol.result_frame(state.request_id, seq, result)
            self._write(frame)

    def _emit_preflight_error(self, request_id: str, code: ErrorCode, message: str) -> None:
        with self._lock:
            if request_id:
                seq = self._next_seq(request_id)
                self._write(protocol.error_frame(request_id, seq, code, message))
            else:
                # The id could not be recovered; the ratified schema forbids
                # an empty requestId, so the frame omits requestId and seq.
                self._write(protocol.channel_error_frame(code, message))


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point of python -m visionlens.worker."""
    level_name = os.environ.get("VISIONLENS_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level_name, logging.INFO),
        stream=sys.stderr,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    # Self-pipe signal handling: the handler only sets an event, the
    # interpreter writes the wake byte through signal.set_wakeup_fd, and the
    # reader raises from its own select loop. An exception raised inside the
    # handler itself can land in foreign code (the logging module swallows
    # it) and lose the shutdown, so nothing raises from the handler.
    wake_read_fd, wake_write_fd = os.pipe()
    os.set_blocking(wake_read_fd, False)
    os.set_blocking(wake_write_fd, False)
    shutdown_event = threading.Event()
    # Values typed as signal.signal's own return union, so the restore below
    # needs no cast and no ignore.
    previous_handlers: dict[int, Callable[[int, FrameType | None], Any] | int | None] = {}

    def _on_signal(signum: int, frame: object) -> None:
        shutdown_event.set()

    def _wake() -> None:
        raise _GracefulExit("shutdown signal")

    try:
        signal.set_wakeup_fd(wake_write_fd)
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, _on_signal)
        worker = Worker(
            reader=sys.stdin.buffer,
            writer=sys.stdout.buffer,
            wakeup_fd=wake_read_fd,
            wake_handler=_wake,
            shutdown_event=shutdown_event,
        )
        try:
            return worker.run()
        except _GracefulExit:
            # A signal landed outside the reader loop; daemon threads stop
            # with the process and the host is tearing the session down.
            return 0
        except BrokenPipeError:
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, sys.stdout.fileno())
            return 0
        finally:
            try:
                sys.stdout.buffer.flush()
            except Exception:
                devnull = os.open(os.devnull, os.O_WRONLY)
                os.dup2(devnull, sys.stdout.fileno())
    finally:
        signal.set_wakeup_fd(-1)
        for restored_signum, handler in previous_handlers.items():
            signal.signal(restored_signum, handler)
        os.close(wake_read_fd)
        os.close(wake_write_fd)


if __name__ == "__main__":
    sys.exit(main())
