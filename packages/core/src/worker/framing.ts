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

// ------------------------------------------------------------------- stderr
//
// Task 1.6 (FR-001): logs travel on stderr and are captured as STRUCTURED
// records with secret redaction. Stdout stays reserved for frames (the
// decoder above is the only reader of it).

/** The literal every redacted secret becomes. */
export const REDACTED = '[redacted]';

/**
 * The literal every redacted local path becomes.
 *
 * The pack asks the logs and traces to redact the local paths of the user
 * and to record hashes and ids instead
 * (`docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:16`), so a captured
 * stderr line never carries the directory a file lives in.
 */
export const REDACTED_PATH = '[redacted-path]';

/**
 * Secret-bearing names whose VALUE must never reach a log or an error
 * message. Matched case-insensitively in `key=value`, `key: value`,
 * `key="value"`, `key='value'`, `{"key":"value"}` and `{'key': 'value'}`
 * forms (a closing quote and any space may sit between the name and the
 * separator). The leading and trailing `[A-Za-z0-9_-]*` let compound names
 * match whole (`client_secret`, `OPENAI_API_KEY`), never just their
 * secret-bearing half.
 */
const SECRET_NAME_PATTERN =
  '[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|authorization)[A-Za-z0-9_-]*';

/**
 * The names that MATCH {@link SECRET_NAME_PATTERN} but name routine ML
 * diagnostics, not secrets: token COUNTS and the tokenizer. Their values are
 * budgets and counts, the kind a worker logs on every batch, so redacting
 * them would erase the diagnostics stderr exists for. `access_token`,
 * `auth_token`, `refresh_token`, `token_value` and every other compound stay
 * secrets: only these exact names (case-insensitive) are carved out.
 */
const NON_SECRET_NAMES = new Set([
  'tokens',
  'token_count',
  'token_counts',
  'num_tokens',
  'total_tokens',
  'used_tokens',
  'max_tokens',
  'tokenizer',
]);

/**
 * `name=value`, `name: value`, `name="value"`, `name='value'`,
 * `name"="value"` (any case). The value may carry a `Bearer` prefix, so an
 * `Authorization: Bearer x` header loses the whole value, not just the word
 * Bearer. Group 1 is the lead-in (name plus separator), group 2 the bare
 * name (checked against {@link NON_SECRET_NAMES}), group 3 the value.
 */
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `(\\b(${SECRET_NAME_PATTERN})\\b["']?[\\s]*[:=][\\s]*)(?:bearer\\s+)?("[^"]*"|'[^']*'|[^\\s,;]+)`,
  'gi',
);

/** A bearer token in an Authorization header or in prose. */
const BEARER_PATTERN = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

/** Provider key shapes that are secrets on their own (the OpenAI style). */
const PROVIDER_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

/**
 * An absolute local path, at the start of the line or after a separator.
 *
 * The roots are the ones a user path starts with on the platforms this
 * platform runs on. The path has to begin at a boundary, so the path of a
 * URL (`https://host/path`) and the path of a message that names a file
 * inside a word are not touched: the URL is not a local path, and a path
 * that starts mid-word is not a path a user supplied.
 */
const LOCAL_PATH_PATTERN =
  /(^|[\s"'([=])(?:\/(?:Users|home|Volumes|private|tmp|var|mnt|media|opt)\/[^\s"'<>)\]]*)/g;

/**
 * Redacts secrets and local paths from one stderr line (FR-001: "logs on
 * stderr with secret redaction").
 *
 * Every occurrence is replaced; text that names no secret and no local
 * path is returned unchanged, so legitimate content (a sha256 digest, a
 * model id, a device name) survives.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (match, leadIn: string, name: string) =>
        NON_SECRET_NAMES.has(name.toLowerCase()) ? match : `${leadIn}${REDACTED}`,
    )
    .replace(BEARER_PATTERN, `$1 ${REDACTED}`)
    .replace(PROVIDER_KEY_PATTERN, REDACTED)
    .replace(LOCAL_PATH_PATTERN, `$1${REDACTED_PATH}`);
}

/** One structured stderr record: when it was captured and what it said. */
export interface WorkerLogRecord {
  /** ISO timestamp of the capture. */
  readonly at: string;
  /** The redacted log line. */
  readonly line: string;
}

/** How many stderr records are kept (the bounded diagnostics tail). */
const MAX_LOG_RECORDS = 128;

/** How much of one stderr line is kept. */
const MAX_LOG_LINE_CHARS = 1024;

/** The marker a line carries when more than the cap was discarded. */
const TRUNCATION_MARKER = ' [truncated]';

/**
 * Structured, bounded capture of the worker's stderr.
 *
 * Each complete line becomes one {@link WorkerLogRecord}, timestamped and
 * redacted; the buffer keeps at most {@link MAX_LOG_RECORDS} records (the
 * tail) and truncates each line to {@link MAX_LOG_LINE_CHARS} characters.
 * The UNTERMINATED remainder is capped too, with the same bound: newline-free
 * output (a `\r` progress bar, a crash blob, a hostile worker) can never
 * accumulate, and a line trimmed by either path keeps its tail and ends with
 * the `[truncated]` marker, like the frame decoder's size refusal.
 */
export class WorkerStderrLog {
  private readonly recordsList: WorkerLogRecord[] = [];
  private partial = '';
  private truncated = false;

  /** Feeds one stderr chunk; lines are split, redacted and timestamped. */
  push(chunk: Buffer): void {
    let text = this.partial + chunk.toString('utf8');
    let newlineAt = text.indexOf('\n');
    while (newlineAt !== -1) {
      this.appendLine(text.slice(0, newlineAt));
      text = text.slice(newlineAt + 1);
      newlineAt = text.indexOf('\n');
    }
    // Only the unterminated remainder is capped: complete lines were already
    // handed off, so this never drops a whole line, only the HEAD of a line
    // that outgrew the cap without ending. The tail is the part that says
    // what happened, so the tail is kept and the marker added.
    if (text.length > MAX_LOG_LINE_CHARS) {
      text = text.slice(-(MAX_LOG_LINE_CHARS - TRUNCATION_MARKER.length));
      this.truncated = true;
    }
    this.partial = text;
  }

  /** The captured records, oldest first. */
  records(): readonly WorkerLogRecord[] {
    return this.recordsList;
  }

  /** The redacted tail as one text block, for error messages. */
  excerpt(): string {
    return this.recordsList.map((record) => record.line).join('\n');
  }

  private appendLine(rawLine: string): void {
    // Redact the FULL line before any truncation: keeping only the tail of a
    // long line would cut the secret's name out of the window and leave its
    // value readable in the kept tail.
    const redactedFull = redactSecrets(rawLine.trimEnd());
    const truncated = this.truncated || redactedFull.length > MAX_LOG_LINE_CHARS;
    this.truncated = false;
    const line = truncated
      ? redactedFull.slice(-(MAX_LOG_LINE_CHARS - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
      : redactedFull.slice(0, MAX_LOG_LINE_CHARS);
    if (line.length === 0) return;
    this.recordsList.push({ at: new Date().toISOString(), line });
    if (this.recordsList.length > MAX_LOG_RECORDS) {
      this.recordsList.splice(0, this.recordsList.length - MAX_LOG_RECORDS);
    }
  }
}
