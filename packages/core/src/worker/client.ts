import { spawn, type ChildProcess } from 'node:child_process';
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
import { encodeFrame, FrameSizeError, LineDecoder } from './framing.js';
import { assertMajorsCompatible, buildHostHello, parseWorkerHello } from './handshake.js';

/**
 * The host side of the `visionlens.worker.v1` channel.
 *
 * Frames in, frames out, nothing else on those channels: the child's stdout
 * carries frames only, its stderr is captured as diagnostics, and the host
 * writes hello, request and cancel frames to the child's stdin. The
 * interpreter and the worker script come from the environment (or explicit
 * options), never from a hardcoded absolute path: they are the seam for a
 * container runtime or a virtualenv.
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

/** How much worker stderr is kept for diagnostics. */
const STDERR_TAIL_BYTES = 8 * 1024;

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
      child = spawn(interpreter, [scriptPath, ...(options.scriptArgs ?? [])], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
        shell: false,
      });
    } catch (cause) {
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
  private readonly stderrTail: Buffer[] = [];
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
    this.stderrTail.push(chunk);
    let total = this.stderrTail.reduce((sum, part) => sum + part.byteLength, 0);
    while (total > STDERR_TAIL_BYTES && this.stderrTail.length > 1) {
      total -= this.stderrTail.shift()!.byteLength;
    }
  }

  private stderrExcerpt(): string {
    const text = Buffer.concat(this.stderrTail).toString('utf8').trim();
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
