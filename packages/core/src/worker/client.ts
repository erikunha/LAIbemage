import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  CONTRACTS_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  WORKER_PROTOCOL_ID,
  WorkerCancelFrameSchema,
  WorkerErrorFrameSchema,
  WorkerProgressFrameSchema,
  WorkerRequestFrameSchema,
  WorkerResultFrameSchema,
  type WorkerBudget,
  type WorkerHelloFrame,
  type WorkerOperation,
  type WorkerProgressFrame,
  type WorkerRequestFrame,
  type WorkerResultFrame,
} from '@vision-lens/contracts';
import { runCancellationLadder, waitFor, type CancellationOutcome } from './cancel.js';
import { WorkerDeadlineError, WorkerLaunchError, WorkerProtocolError } from './errors.js';
import { encodeFrame, FrameSizeError, LineDecoder, WorkerStderrLog } from './framing.js';
import { assertMajorsCompatible, buildHostHello, parseWorkerHello } from './handshake.js';
import { spawnWorkerProcess } from './host.js';

/**
 * The host side of the `visionlens.worker.v1` channel.
 *
 * Frames in, frames out, nothing else on those channels: the child's stdout
 * carries frames only, its stderr is captured as structured, redacted log
 * records ({@link WorkerClient.workerLogs}), and the host writes hello,
 * request and cancel frames to the child's stdin. The interpreter and the
 * worker script come from the environment (or explicit options), never from
 * a hardcoded absolute path: they are the seam for a container runtime or a
 * virtualenv. The launch itself is owned by `host.ts`: a fixed interpreter
 * allowlist, pipes only, no shell.
 */

/** Environment variable carrying the interpreter executable (for example python3). */
export const WORKER_INTERPRETER_ENV = 'VISION_LENS_WORKER_INTERPRETER';

/** Environment variable carrying the worker script path. */
export const WORKER_SCRIPT_ENV = 'VISION_LENS_WORKER_SCRIPT';

/** Default interpreter: a PATH-resolved name, never an absolute path. */
const DEFAULT_INTERPRETER = 'python3';

/** Default worker script: resolved against the working directory. */
const DEFAULT_SCRIPT = 'worker.py';

/** Lifecycle of one client. */
export type WorkerClientState = 'handshaking' | 'running' | 'closed' | 'dead';

export interface WorkerClientOptions {
  /** Interpreter executable; defaults to $VISION_LENS_WORKER_INTERPRETER, then python3. */
  interpreter?: string;
  /** Worker script path; defaults to $VISION_LENS_WORKER_SCRIPT, then worker.py. */
  scriptPath?: string;
  /** Extra argv entries after the script path. */
  scriptArgs?: readonly string[];
  /** Extra environment entries merged over the host environment. */
  env?: NodeJS.ProcessEnv;
  /** Handshake timeout in milliseconds (default 10 000). */
  handshakeTimeoutMs?: number;
  /** Host-side frame cap; the effective limit is the handshake minimum (default 1 MiB). */
  maxFrameBytes?: number;
  /** Grace window for a cancel acknowledgement before SIGTERM (default 1 500). */
  cancelGraceMs?: number;
  /** Grace window after SIGTERM before SIGKILL (default 1 500). */
  terminateGraceMs?: number;
  /** Contract version the host announces and stamps on requests (default CONTRACTS_VERSION). */
  contractVersion?: string;
  /** Reports protocol violations that do not fail a request (duplicate result, late frame). */
  onViolation?: (description: string) => void;
}

/** Input of one {@link WorkerClient.request} call. */
export interface WorkerRequestInput {
  /** Caller-owned id; defaults to a generated one. Reuse is refused. */
  requestId?: string;
  operation: WorkerOperation;
  workspaceId: string;
  /** Free-form operation parameters. */
  params: Record<string, unknown>;
  budget: WorkerBudget;
  /** Surfaced for every progress frame of this request, in order. */
  onProgress?: (frame: WorkerProgressFrame) => void;
}

/** The terminal success of one request. */
export interface WorkerRequestResult {
  requestId: string;
  seq: number;
  /** The free-form result payload; its shape belongs to the operation. */
  result: WorkerResultFrame['result'];
}

interface PendingRequest {
  requestId: string;
  budget: WorkerBudget;
  resolve: (value: WorkerRequestResult) => void;
  reject: (error: Error) => void;
  onProgress?: (frame: WorkerProgressFrame) => void;
  /** Last seq seen for this request; -1 before the first frame. */
  lastSeq: number;
  /** True once a result, an error, a deadline or an escalation settled it. */
  terminated: boolean;
  /** True while a cancellation ladder is stopping it (an exit then reads as cancelled). */
  cancelling: boolean;
  deadlineTimer: NodeJS.Timeout | null;
}

const DEFAULTS = {
  handshakeTimeoutMs: 10_000,
  cancelGraceMs: 1_500,
  terminateGraceMs: 1_500,
} as const;

export class WorkerClient {
  /**
   * Spawns the worker process and completes the handshake before returning.
   *
   * Rejects with {@link WorkerLaunchError} for a spawn error, a handshake
   * timeout or a worker that died during the handshake, and with
   * {@link WorkerProtocolError} for a hello that violates the wire contract
   * (another protocol id, another major, an invalid shape). No request frame
   * is ever written when the handshake fails.
   */
  static async launch(options: WorkerClientOptions = {}): Promise<WorkerClient> {
    const interpreter =
      options.interpreter ?? process.env[WORKER_INTERPRETER_ENV] ?? DEFAULT_INTERPRETER;
    const scriptPath = options.scriptPath ?? process.env[WORKER_SCRIPT_ENV] ?? DEFAULT_SCRIPT;

    let child: ChildProcess;
    try {
      // Task 1.5 (FR-014): the launch lives in host.ts. The interpreter must
      // pass the fixed allowlist, the child gets pipes only (nothing
      // inherited), and the script path travels as argv, never through a
      // shell.
      child = spawnWorkerProcess({
        interpreter,
        scriptPath,
        scriptArgs: options.scriptArgs,
        env: { ...process.env, ...options.env },
      });
    } catch (cause) {
      if (cause instanceof WorkerLaunchError) throw cause;
      throw new WorkerLaunchError(
        'spawn-error',
        `the worker process could not be started: ${interpreter} ${scriptPath}`,
        { cause },
      );
    }

    const client = new WorkerClient(child, interpreter, scriptPath, options);
    try {
      await client.handshake;
    } catch (error) {
      await client.dispose();
      throw error;
    }
    return client;
  }

  private state: WorkerClientState = 'handshaking';
  private readonly pending = new Map<string, PendingRequest>();
  private readonly terminatedIds = new Set<string>();
  private readonly cancelAcks = new Set<string>();
  private readonly decoder: LineDecoder;
  private readonly stderrLog = new WorkerStderrLog();
  private readonly handshakePromise: Promise<void>;
  private handshakeResolvers: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private workerHello: WorkerHelloFrame | null = null;
  private negotiatedMaxFrameBytes: number;
  private exited = false;
  private exitWaiters: Array<() => void> = [];
  private handshakeTimeout: NodeJS.Timeout;

  private constructor(
    private readonly child: ChildProcess,
    private readonly interpreter: string,
    private readonly scriptPath: string,
    private readonly options: WorkerClientOptions,
  ) {
    this.handshakePromise = new Promise((resolve, reject) => {
      this.handshakeResolvers = { resolve, reject };
    });
    this.negotiatedMaxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.decoder = new LineDecoder(this.negotiatedMaxFrameBytes);

    child.on('error', (error) => this.handleChildError(error));
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.stdout?.on('data', (chunk: Buffer) => this.handleChunk(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.captureStderr(chunk));
    // The exit path owns EPIPE failures; this handler only stops an uncaught throw.
    child.stdin?.on('error', () => undefined);

    this.handshakeTimeout = setTimeout(() => {
      this.rejectHandshake(
        new WorkerLaunchError(
          'handshake-timeout',
          `the worker did not send its hello within ${
            options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs
          } ms: ${this.interpreter} ${this.scriptPath}`,
        ),
      );
    }, options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs);
    this.handshakeTimeout.unref?.();
  }

  /** Resolves once the handshake completed; rejects on any handshake failure. */
  get handshake(): Promise<void> {
    return this.handshakePromise;
  }

  /** The worker's validated hello frame. */
  get hello(): WorkerHelloFrame {
    if (!this.workerHello) throw new Error('the handshake has not completed');
    return this.workerHello;
  }

  /** The effective frame limit: the minimum of both sides of the handshake. */
  get maxFrameBytes(): number {
    return this.negotiatedMaxFrameBytes;
  }

  get clientState(): WorkerClientState {
    return this.state;
  }

  /**
   * The worker's stderr as structured, redacted log records (task 1.6).
   *
   * Bounded to the most recent lines; each record carries its capture
   * timestamp and its already-redacted text, so a secret the worker printed
   * never reaches a caller.
   */
  workerLogs(): readonly import('./framing.js').WorkerLogRecord[] {
    return this.stderrLog.records();
  }

  supportsOperation(operation: WorkerOperation): boolean {
    return this.hello.supportedOperations.includes(operation);
  }

  /**
   * Sends one request and resolves with its result.
   *
   * Rejects with {@link WorkerProtocolError} for a wire refusal (an
   * unadvertised operation, an oversized frame, a code-bearing error frame, a
   * protocol violation), with {@link WorkerDeadlineError} when
   * `budget.maxSeconds` elapses, and with {@link WorkerLaunchError} when the
   * worker dies.
   */
  async request(input: WorkerRequestInput): Promise<WorkerRequestResult> {
    if (this.state !== 'running') {
      throw new Error(`the worker client is ${this.state}, not running`);
    }
    if (!this.supportsOperation(input.operation)) {
      throw new WorkerProtocolError(
        'UNSUPPORTED_OPERATION',
        `the operation "${input.operation}" is not in the worker's advertised set: ${this.hello.supportedOperations.join(', ')}`,
      );
    }
    const requestId = input.requestId ?? `r-${randomUUID()}`;
    if (this.pending.has(requestId) || this.terminatedIds.has(requestId)) {
      throw new Error(`requestId "${requestId}" is already in flight or already terminated`);
    }

    let frame: WorkerRequestFrame;
    try {
      frame = WorkerRequestFrameSchema.parse({
        protocol: WORKER_PROTOCOL_ID,
        kind: 'request',
        requestId,
        operation: input.operation,
        contractVersion: this.options.contractVersion ?? CONTRACTS_VERSION,
        workspaceId: input.workspaceId,
        params: input.params,
        budget: input.budget,
      });
    } catch (cause) {
      throw new WorkerProtocolError(
        'MALFORMED_FRAME',
        `the outgoing request frame is invalid: ${describeZodIssue(cause)}`,
      );
    }

    const encoded = encodeFrame(frame);
    if (encoded.byteLength > this.negotiatedMaxFrameBytes) {
      throw new WorkerProtocolError(
        'MALFORMED_FRAME',
        new FrameSizeError(encoded.byteLength, this.negotiatedMaxFrameBytes).message,
      );
    }

    return new Promise<WorkerRequestResult>((resolve, reject) => {
      const entry: PendingRequest = {
        requestId,
        budget: frame.budget,
        resolve,
        reject,
        onProgress: input.onProgress,
        lastSeq: -1,
        terminated: false,
        cancelling: false,
        deadlineTimer: null,
      };
      this.pending.set(requestId, entry);
      entry.deadlineTimer = setTimeout(
        () => this.handleDeadline(entry),
        frame.budget.maxSeconds * 1000,
      );
      entry.deadlineTimer.unref?.();
      try {
        this.writeFrame(encoded);
      } catch (error) {
        this.settle(entry);
        reject(
          error instanceof Error
            ? error
            : new WorkerLaunchError('worker-died', 'the worker stdin is no longer writable'),
        );
      }
    });
  }

  /**
   * Cancels one in-flight request through the ladder: cancel frame, grace
   * window, SIGTERM, SIGKILL. The cancelled request rejects with code
   * CANCELLED and never resolves with a result.
   */
  async cancel(requestId: string): Promise<CancellationOutcome> {
    const pending = this.pending.get(requestId);
    if (!pending) return 'no-op';

    pending.cancelling = true;
    if (this.state === 'running') {
      this.writeFrame(
        encodeFrame(
          WorkerCancelFrameSchema.parse({ protocol: WORKER_PROTOCOL_ID, kind: 'cancel', requestId }),
        ),
      );
    }

    const outcome = await runCancellationLadder({
      child: this.child,
      isAcknowledged: () => this.cancelAcks.has(requestId),
      hasExited: () => this.exited,
      graceMs: this.options.cancelGraceMs ?? DEFAULTS.cancelGraceMs,
      terminateMs: this.options.terminateGraceMs ?? DEFAULTS.terminateGraceMs,
      waitForExit: () => this.waitForExit(),
    });

    if (this.settle(pending)) {
      pending.reject(
        new WorkerProtocolError(
          'CANCELLED',
          `the request ${requestId} was cancelled by escalation (${outcome})`,
        ),
      );
    }
    return outcome;
  }

  /** Stops the worker: stdin end, then SIGTERM, then SIGKILL, bounded in time. */
  async close(): Promise<void> {
    if (this.state === 'running' || this.state === 'handshaking') {
      this.state = 'closed';
      for (const entry of [...this.pending.values()]) {
        if (this.settle(entry)) {
          entry.reject(
            new WorkerLaunchError('worker-died', 'the worker client was closed mid-request'),
          );
        }
      }
      this.child.stdin?.end();
      if (!this.exited) {
        const graceMs = this.options.terminateGraceMs ?? DEFAULTS.terminateGraceMs;
        const ended = await waitFor(() => this.exited, graceMs);
        if (!ended && !this.exited) {
          this.child.kill('SIGTERM');
          const terminated = await waitFor(() => this.exited, graceMs);
          if (!terminated && !this.exited) this.child.kill('SIGKILL');
        }
      }
    }
    await this.waitForExit();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  // ---------------------------------------------------------------- intake

  private handleChunk(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (error) {
      if (error instanceof FrameSizeError) {
        this.failChannel(new WorkerProtocolError('MALFORMED_FRAME', error.message));
        return;
      }
      throw error;
    }
    for (const line of lines) {
      try {
        this.handleLine(line);
      } catch (error) {
        if (error instanceof WorkerProtocolError) {
          if (this.state === 'handshaking') this.rejectHandshake(error);
          else this.failChannel(error);
          return;
        }
        if (error instanceof WorkerLaunchError) {
          if (this.state === 'handshaking') this.rejectHandshake(error);
          else {
            this.markDead();
            this.rejectAllPending(error);
            void this.dispose().catch(() => undefined);
          }
          return;
        }
        throw error;
      }
    }
  }

  private handleLine(line: string): void {
    if (this.state === 'handshaking') {
      const hello = parseWorkerHello(line);
      assertMajorsCompatible(hello, this.options.contractVersion ?? CONTRACTS_VERSION);
      this.workerHello = hello;
      this.negotiatedMaxFrameBytes = Math.min(
        hello.maxFrameBytes,
        this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      );
      this.decoder.maxBytes = this.negotiatedMaxFrameBytes;
      this.writeFrame(
        encodeFrame(
          buildHostHello({
            contractVersion: this.options.contractVersion ?? CONTRACTS_VERSION,
            maxFrameBytes: this.negotiatedMaxFrameBytes,
          }),
        ),
      );
      this.state = 'running';
      clearTimeout(this.handshakeTimeout);
      this.handshakeResolvers?.resolve();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new WorkerProtocolError(
        'MALFORMED_FRAME',
        'the worker wrote a stdout line that is not valid JSON; stdout carries frames only',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new WorkerProtocolError(
        'MALFORMED_FRAME',
        'the worker wrote a line that is not a frame object',
      );
    }
    const kind = (parsed as { kind?: unknown }).kind;
    if (kind === 'progress' || kind === 'result' || kind === 'error') {
      this.handleEventFrame(parsed);
      return;
    }
    if (kind === 'hello') {
      throw new WorkerProtocolError('MALFORMED_FRAME', 'the worker sent hello outside the handshake');
    }
    throw new WorkerProtocolError(
      'MALFORMED_FRAME',
      `the frame kind "${String(kind)}" may not travel from the worker to the host`,
    );
  }

  private handleEventFrame(raw: unknown): void {
    const kind = (raw as { kind?: unknown }).kind;
    const schema =
      kind === 'progress'
        ? WorkerProgressFrameSchema
        : kind === 'result'
          ? WorkerResultFrameSchema
          : WorkerErrorFrameSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new WorkerProtocolError(
        'MALFORMED_FRAME',
        `the worker ${String(kind)} frame is invalid: ${describeZodIssue(parsed.error)}`,
      );
    }
    const frame = parsed.data;

    const requestId = frame.requestId;
    if (requestId === undefined) {
      // An error whose request id could not be recovered: reported, never skipped.
      const code = frame.kind === 'error' ? frame.code : '(unknown code)';
      const message = frame.kind === 'error' ? frame.message : '(no message)';
      this.reportViolation(`the worker reported a channel-level error ${code}: ${message}`);
      return;
    }

    const entry = this.pending.get(requestId);
    if (!entry) {
      if (this.terminatedIds.has(requestId)) {
        this.reportViolation(
          `a ${frame.kind} frame for ${requestId} arrived after the request terminated; the first outcome stands`,
        );
      } else {
        this.reportViolation(`a ${frame.kind} frame arrived for unknown requestId ${requestId}`);
      }
      return;
    }

    if (!this.checkSeq(entry, frame.seq)) return;

    if (frame.kind === 'progress') {
      entry.onProgress?.(frame);
      return;
    }
    if (frame.kind === 'error') {
      if (frame.code === 'CANCELLED') this.cancelAcks.add(requestId);
      this.settle(entry);
      entry.reject(new WorkerProtocolError(frame.code, frame.message));
      return;
    }
    const seq = frame.seq;
    const result = frame.result;
    this.settle(entry);
    entry.resolve({ requestId, seq, result });
  }

  /**
   * seq strictly increases per request and starts at 0.
   *
   * An error frame whose request id could not be recovered may omit seq, and
   * such frames never reach a pending request, so `undefined` passes through.
   *
   * Returns false when the frame violated the rule and the request was failed.
   */
  private checkSeq(entry: PendingRequest, seq: number | undefined): boolean {
    if (seq === undefined) return true;
    if (entry.lastSeq === -1 && seq !== 0) {
      this.failRequest(entry, `the first frame for ${entry.requestId} carried seq ${seq}, not 0`);
      return false;
    }
    if (seq <= entry.lastSeq) {
      this.failRequest(
        entry,
        `seq did not strictly increase for ${entry.requestId}: ${seq} after ${entry.lastSeq}`,
      );
      return false;
    }
    entry.lastSeq = seq;
    return true;
  }

  private failRequest(entry: PendingRequest, violation: string): void {
    if (this.settle(entry)) {
      entry.reject(new WorkerProtocolError('MALFORMED_FRAME', violation));
    }
  }

  private handleDeadline(entry: PendingRequest): void {
    if (!this.settle(entry)) return;
    entry.reject(new WorkerDeadlineError(entry.requestId, entry.budget.maxSeconds));
    // Stop the operation through the ladder; the request itself already failed.
    entry.cancelling = true;
    void this.stopAfterDeadline(entry).catch(() => undefined);
  }

  private async stopAfterDeadline(entry: PendingRequest): Promise<void> {
    if (this.state === 'running') {
      this.writeFrame(
        encodeFrame(
          WorkerCancelFrameSchema.parse({
            protocol: WORKER_PROTOCOL_ID,
            kind: 'cancel',
            requestId: entry.requestId,
          }),
        ),
      );
    }
    await runCancellationLadder({
      child: this.child,
      isAcknowledged: () => this.cancelAcks.has(entry.requestId),
      hasExited: () => this.exited,
      graceMs: this.options.cancelGraceMs ?? DEFAULTS.cancelGraceMs,
      terminateMs: this.options.terminateGraceMs ?? DEFAULTS.terminateGraceMs,
      waitForExit: () => this.waitForExit(),
    });
  }

  // ---------------------------------------------------------------- output

  private writeFrame(buffer: Buffer): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) {
      throw new WorkerLaunchError('worker-died', 'the worker stdin is no longer writable');
    }
    stdin.write(buffer);
  }

  // ---------------------------------------------------------------- failure

  private handleChildError(error: Error): void {
    // A process that failed to spawn never exits: there is nothing to wait for.
    this.exited = true;
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    if (this.state === 'handshaking') {
      this.rejectHandshake(
        new WorkerLaunchError(
          'spawn-error',
          `the worker process could not be started: ${this.interpreter} ${this.scriptPath} (${error.message})`,
          { cause: error },
        ),
      );
      return;
    }
    if (this.state === 'running') {
      this.markDead();
      this.rejectAllPending(
        new WorkerLaunchError('worker-died', `the worker process failed: ${error.message}`, {
          cause: error,
        }),
      );
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    if (this.state === 'handshaking') {
      this.rejectHandshake(
        new WorkerLaunchError(
          'worker-died',
          `the worker exited during the handshake (code ${code ?? 'none'}, signal ${signal ?? 'none'}): ${this.interpreter} ${this.scriptPath}${this.stderrExcerpt()}`,
        ),
      );
      return;
    }
    if (this.state === 'running') {
      this.markDead();
      for (const entry of [...this.pending.values()]) {
        if (!this.settle(entry)) continue;
        if (entry.cancelling) {
          entry.reject(
            new WorkerProtocolError(
              'CANCELLED',
              `the request ${entry.requestId} was cancelled; the worker exited during escalation`,
            ),
          );
        } else {
          entry.reject(
            new WorkerLaunchError(
              'worker-died',
              `the worker exited mid-request (code ${code ?? 'none'}, signal ${signal ?? 'none'})${this.stderrExcerpt()}`,
            ),
          );
        }
      }
    }
  }

  /**
   * A protocol violation that poisons the channel: every in-flight request
   * fails with the violation and the worker is stopped.
   */
  private failChannel(error: WorkerProtocolError): void {
    if (this.state === 'handshaking') {
      this.rejectHandshake(error);
      return;
    }
    if (this.state !== 'running') return;
    this.markDead();
    for (const entry of [...this.pending.values()]) {
      if (this.settle(entry)) entry.reject(error);
    }
    void this.dispose().catch(() => undefined);
  }

  private markDead(): void {
    this.state = 'dead';
    clearTimeout(this.handshakeTimeout);
  }

  private rejectAllPending(error: Error): void {
    for (const entry of [...this.pending.values()]) {
      if (this.settle(entry)) entry.reject(error);
    }
  }

  private rejectHandshake(error: Error): void {
    if (this.state !== 'handshaking') return;
    this.markDead();
    this.handshakeResolvers?.reject(error);
  }

  private settle(entry: PendingRequest): boolean {
    if (entry.terminated) return false;
    entry.terminated = true;
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    this.pending.delete(entry.requestId);
    this.terminatedIds.add(entry.requestId);
    return true;
  }

  private reportViolation(description: string): void {
    this.options.onViolation?.(description);
  }

  // ---------------------------------------------------------------- teardown

  private captureStderr(chunk: Buffer): void {
    this.stderrLog.push(chunk);
  }

  private stderrExcerpt(): string {
    const text = this.stderrLog.excerpt().trim();
    return text ? `; worker stderr: ${text.slice(-512)}` : '';
  }

  private waitForExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  /** Kills the child outright; used when the handshake failed or the channel broke. */
  private async dispose(): Promise<void> {
    this.markDead();
    for (const entry of [...this.pending.values()]) {
      if (this.settle(entry)) {
        entry.reject(new WorkerLaunchError('worker-died', 'the worker channel was disposed'));
      }
    }
    if (!this.exited) {
      this.child.kill('SIGTERM');
      const terminated = await waitFor(
        () => this.exited,
        this.options.terminateGraceMs ?? DEFAULTS.terminateGraceMs,
      );
      if (!terminated && !this.exited) this.child.kill('SIGKILL');
    }
    await this.waitForExit();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }
}

/** Renders a zod failure as one compact line for an error message. */
function describeZodIssue(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: Array<{ path: Array<string | number>; message: string }> })
      .issues;
    const first = issues[0];
    if (first) return `${first.path.join('.') || '(root)'}: ${first.message}`;
  }
  return String(error);
}

// -------------------------------------------------------------------- retry

/**
 * The bounded backoff policy of the worker host (task 2.6, FR-011).
 *
 * Every attempt is spaced by an exponentially growing delay with FULL
 * JITTER (a uniform roll over `[0, min(maxDelayMs, baseDelayMs * 2^attempt)]`),
 * capped by `maxDelayMs`, for at most `maxAttempts` attempts in total.
 */
export interface WorkerRetryPolicy {
  /** Total attempts, including the first one (default 3). */
  readonly maxAttempts: number;
  /** The delay base in milliseconds (default 100). */
  readonly baseDelayMs: number;
  /** The delay ceiling in milliseconds (default 2 000). */
  readonly maxDelayMs: number;
}

/** The default policy: three attempts, 100 ms base, 2 s ceiling. */
export const DEFAULT_WORKER_RETRY_POLICY: WorkerRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
} as const;

/** The random source of the jitter; injectable for determinism under test. */
export type RetryRandom = () => number;

/**
 * The delay before attempt `attempt` (1 = the first retry), with full
 * jitter: a uniform roll over `[0, min(maxDelayMs, baseDelayMs * 2^(attempt-1))]`.
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: WorkerRetryPolicy,
  random: RetryRandom = Math.random,
): number {
  const exponentialCap = policy.baseDelayMs * 2 ** (attempt - 1);
  const cap = Math.min(policy.maxDelayMs, exponentialCap);
  return Math.floor(cap * Math.min(Math.max(random(), 0), 1));
}

/** What a {@link RetryReconcile} sees about the failed attempt. */
export interface RetryReconcileContext {
  /** Which attempt failed; 1 is the first attempt. */
  readonly attempt: number;
  /** The requestId that failed (a later attempt gets a fresh one). */
  readonly requestId: string;
  /** The failure the attempt ended with. */
  readonly error: unknown;
}

/**
 * Proves a failed NON-idempotent attempt had no external effect, so a retry
 * cannot double-apply it. Returning false stops the retry.
 */
export type RetryReconcile = (context: RetryReconcileContext) => Promise<boolean> | boolean;

/** The retry options of {@link requestWithRetry}. */
export interface WorkerRetryOptions {
  /** The backoff policy; defaults to {@link DEFAULT_WORKER_RETRY_POLICY}. */
  readonly policy?: WorkerRetryPolicy;
  /**
   * True only when the caller KNOWS the operation is idempotent (a failed
   * attempt provably left no external state). Default false: unknown is
   * treated as NON-idempotent.
   */
  readonly idempotent?: boolean;
  /**
   * The reconciliation hook for a non-idempotent request: it must prove the
   * failed attempt had no external effect before a retry is allowed
   * (FR-011: never blind-retry a non-idempotent external action).
   */
  readonly reconcile?: RetryReconcile;
  /** The jitter source; injectable for determinism under test. */
  readonly random?: RetryRandom;
}

/** True when the failure is a transient one the policy may retry. */
function isTransientFailure(error: unknown): boolean {
  if (error instanceof WorkerProtocolError || error instanceof WorkerDeadlineError) {
    return error.retryable;
  }
  if (error instanceof WorkerLaunchError) return error.retryable;
  return false;
}

/**
 * True when the failed attempt's EXTERNAL effects are unknown at the host:
 * the worker crashed or died mid-operation, so a non-idempotent external
 * action may or may not have been applied (FR-011). Such failures are never
 * blind-retried.
 *
 * `PROVIDER_UNAVAILABLE` is the opposite: the worker reported the provider
 * never executed the call, so the failure itself proves no external effect
 * and the bounded backoff applies directly.
 */
function hasUnknownExternalEffects(error: unknown): boolean {
  if (error instanceof WorkerProtocolError) return error.code === 'WORKER_CRASHED';
  if (error instanceof WorkerLaunchError) return error.kind === 'worker-died';
  return false;
}

/**
 * Sends one request under the retry policy (task 2.6, FR-011).
 *
 * Three rules, in order:
 *
 *  1. **Deterministic failures are never retried.** The retryable flag of
 *     the frozen error vocabulary decides (an invalid input, an unsupported
 *     operation, a budget or deadline failure returns immediately).
 *  2. **A failure with unknown external effects is never blind-retried.**
 *     When the attempt died mid-operation (`WORKER_CRASHED`, a worker
 *     death), a non-idempotent external action may have been applied: the
 *     retry happens only when the caller declared `idempotent` or when
 *     `reconcile` PROVED the failed attempt had no external effect.
 *     `PROVIDER_UNAVAILABLE` proves by itself that no call executed, so it
 *     backs off directly.
 *  3. **Transient failures back off with jitter, boundedly.** At most
 *     `policy.maxAttempts` attempts total, spaced by
 *     {@link computeBackoffDelayMs}.
 *
 * Every attempt is a NEW request with a NEW requestId (FR-013): the client
 * refuses to reuse a terminated request's id, and a resumed attempt is a new
 * request by definition. The first attempt keeps the caller's id when one
 * was given; later attempts derive `${id}-a${n}` from it.
 */
export async function requestWithRetry(
  client: Pick<WorkerClient, 'request'>,
  input: WorkerRequestInput,
  options: WorkerRetryOptions = {},
): Promise<WorkerRequestResult> {
  const policy = options.policy ?? DEFAULT_WORKER_RETRY_POLICY;
  const idempotent = options.idempotent ?? false;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const requestId =
      input.requestId === undefined || attempt === 1
        ? input.requestId
        : `${input.requestId}-a${attempt}`;

    try {
      return await client.request(requestId === undefined ? input : { ...input, requestId });
    } catch (error) {
      lastError = error;

      if (!isTransientFailure(error)) throw error;
      if (attempt >= policy.maxAttempts) throw error;

      if (hasUnknownExternalEffects(error) && !idempotent) {
        if (!options.reconcile) throw error;
        const provenEffectFree = await options.reconcile({
          attempt,
          requestId: requestId ?? '(generated)',
          error,
        });
        if (!provenEffectFree) throw error;
      }

      const delayMs = computeBackoffDelayMs(attempt, policy, options.random);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
