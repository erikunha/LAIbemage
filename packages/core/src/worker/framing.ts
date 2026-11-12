/**
 * Line framing for the worker channel.
 *
 * Transport rules of the frozen wire contract: one JSON object per line,
 * UTF-8, written with exactly one trailing newline. The worker's stdout
 * carries frames and nothing else; the host enforces the negotiated
 * `maxFrameBytes` on BOTH directions and never buffers an unbounded line.
 */

/** Thrown when a single line would exceed the negotiated frame size. */
export class FrameSizeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`frame of ${bytes} bytes exceeds the negotiated maxFrameBytes of ${maxBytes}`);
    this.name = 'FrameSizeError';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Byte-bounded line decoder.
 *
 * Chunks are pushed in; complete lines come out. A line that would exceed
 * `maxBytes` BEFORE its newline arrives throws {@link FrameSizeError}, so the
 * oversized frame is reported as an oversized frame, never buffered whole and
 * never misread as a parse error.
 */
export class LineDecoder {
  private pending: Buffer = Buffer.alloc(0);

  /** The line-size cap; shrinks when the handshake negotiates a smaller limit. */
  maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** Feeds one chunk; returns every complete line it terminated. */
  push(chunk: Buffer): string[] {
    this.pending = this.pending.byteLength === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const lines: string[] = [];
    let newlineAt = this.pending.indexOf(NEWLINE_BYTE);
    while (newlineAt !== -1) {
      lines.push(this.pending.subarray(0, newlineAt).toString('utf8'));
      this.pending = this.pending.subarray(newlineAt + 1);
      newlineAt = this.pending.indexOf(NEWLINE_BYTE);
    }
    if (this.pending.byteLength > this.maxBytes) {
      throw new FrameSizeError(this.pending.byteLength, this.maxBytes);
    }
    return lines;
  }

  /** Drops any partial line (used when the channel closes). */
  clear(): void {
    this.pending = Buffer.alloc(0);
  }
}

const NEWLINE_BYTE = 0x0a;

/** Serializes a frame to wire form: the JSON object plus exactly one newline. */
export function encodeFrame(frame: object): Buffer {
  return Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
}
